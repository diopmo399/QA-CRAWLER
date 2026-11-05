import {
  GIT_PROVIDERS,
  type Evidence,
  type ImpactReport,
  type MapChange,
  type MapSource,
  type MapSummary,
  type ScanRecord,
  type SourceScan,
} from '../core/cartography.js';
import type { MapStrings } from './dashboard-cartography-i18n.js';
import type { CartographyUi } from './dashboard-cartography.js';
import { icon } from './dashboard-parts.js';
import { esc } from './view.js';

/**
 * LES ÉCRANS « SCAN & DÉCOUVERTE » ET « ANALYSE D'IMPACT ». À gauche les sources du projet (cartes
 * dépliables, champs obligatoires, validations immédiates, erreurs du dernier scan comme l'absence de jeton
 * Git), à droite le dernier scan (étapes, résumé par source, éléments découverts, scans récents, couverture).
 * L'impact compare deux scans choisis : sources comparées, changements comptés, fonctionnalités et
 * scénarios touchés, tableau filtrable. Tout chiffre vient des données ; une source non lue rend la
 * comparaison « indéterminée », jamais « sans changement ».
 */
export interface ScanViewHelpers {
  chip: (raw: string, text: string) => string;
  conf: (value: string) => string;
  layerChip: (layer: string) => string;
  date: (iso: string | undefined) => string;
  paneError: (text: string | undefined) => string;
  evidence: (evidence: Evidence | undefined) => string;
  canEdit: boolean;
  canRun: boolean;
  environments: { id: string; name: string }[];
}

// ── Validation des sources ────────────────────────────────────────────────────────────────────────

export type SourceField =
  'id' | 'name' | 'kind' | 'path' | 'repoUrl' | 'branch' | 'commit' | 'tokenEnv' | 'include';
export type SourceIssues = Partial<Record<SourceField, string>>;

const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\.lock(\/|$))(?!\/)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/;
const COMMIT = /^[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$/;
const VARIABLE = /^[A-Z_][A-Z0-9_]*$/;
const ABSOLUTE = /^(\/|[A-Za-z]:[\\/]|\\\\)/;

/** Les erreurs de chaque source, dans l'ordre de la liste (les mêmes règles que le serveur, sans réseau). */
export function sourceIssues(
  m: MapStrings,
  sources: readonly MapSource[],
  gitHosts: readonly string[] | undefined,
): SourceIssues[] {
  const e = m.sd.errors;
  const ids = sources.map((s) => s.id.trim());
  return sources.map((s, index) => {
    const out: SourceIssues = {};
    const id = s.id.trim();
    if (!id) out.id = e.idRequired;
    else if (!SOURCE_ID.test(id)) out.id = e.idFormat;
    else if (ids.indexOf(id) !== index) out.id = e.idDuplicate;
    if (!s.name.trim()) out.name = e.nameRequired;
    const remote = s.kind === 'GIT';
    if (remote && !gitHosts) out.kind = e.gitDisabled;
    if (remote) {
      const url = s.repoUrl?.trim() ?? '';
      if (!url) out.repoUrl = e.urlRequired;
      else {
        const problem = urlProblem(m, url, gitHosts, true);
        if (problem) out.repoUrl = problem;
      }
      if (s.branch && !BRANCH.test(s.branch)) out.branch = e.branchInvalid;
      if (s.commit && !COMMIT.test(s.commit)) out.commit = e.commitInvalid;
      if (s.tokenEnv && !VARIABLE.test(s.tokenEnv)) out.tokenEnv = e.tokenInvalid;
    } else {
      if (!s.path.trim()) out.path = e.pathRequired;
      else if (!ABSOLUTE.test(s.path.trim())) out.path = e.pathAbsolute;
      const url = s.repoUrl?.trim();
      if (url) {
        const problem = urlProblem(m, url, undefined, false);
        if (problem) out.repoUrl = problem;
      }
    }
    if (s.include.some((dir) => ABSOLUTE.test(dir) || dir.split(/[\\/]/).includes('..')))
      out.include = e.includeInvalid;
    return out;
  });
}

function urlProblem(
  m: MapStrings,
  url: string,
  hosts: readonly string[] | undefined,
  remote: boolean,
): string | undefined {
  const e = m.sd.errors;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return e.urlInvalid;
  }
  if (parsed.username || parsed.password) return e.urlCredentials;
  if (parsed.protocol === 'https:') {
    if (remote && hosts && !hosts.includes(parsed.hostname.toLowerCase()))
      return m.sd.hostRefused(parsed.hostname);
    return undefined;
  }
  // http et file ne sont admis que par un serveur configuré pour (essais) : il tranche à l'enregistrement.
  if (remote && (parsed.protocol === 'http:' || parsed.protocol === 'file:')) return undefined;
  if (!remote && parsed.protocol === 'http:') return undefined;
  return e.urlHttps;
}

export const issueCount = (issues: readonly SourceIssues[]): number =>
  issues.reduce((sum, entry) => sum + Object.keys(entry).length, 0);

// ── Scan & Découverte ─────────────────────────────────────────────────────────────────────────────

const normalize = (s: MapSource | undefined): string =>
  s
    ? JSON.stringify({
        id: s.id,
        name: s.name,
        layer: s.layer,
        kind: s.kind ?? 'LOCAL',
        path: s.path,
        include: s.include,
        enabled: s.enabled,
        repoUrl: s.repoUrl ?? '',
        provider: s.provider ?? '',
        branch: s.branch ?? '',
        commit: s.commit ?? '',
        tokenEnv: s.tokenEnv ?? '',
      })
    : '';

const LAYER_ICON: Record<string, string> = { FRONTEND: 'monitor', BFF: 'network', BACKEND: 'gear' };
const LAYERS = ['FRONTEND', 'BFF', 'BACKEND', 'API', 'DATABASE', 'EVENTS', 'OTHER'];

/** Ce que le dernier scan dit d'un jeton : absent, attendu, refusé. */
function tokenHint(m: MapStrings, source: MapSource, scanned: SourceScan | undefined): string | undefined {
  const errors = scanned?.errors.join('\n') ?? '';
  if (/\[CREDENTIALS_MISSING\]/.test(errors) && source.tokenEnv) return m.sd.tokenMissing(source.tokenEnv);
  if (/\[AUTH_FAILED\]/.test(errors)) return source.tokenEnv ? m.sd.tokenRefused : m.sd.tokenNeeded;
  return undefined;
}

function field(
  label: string,
  control: string,
  key: string,
  error: string | undefined,
  required = false,
  wide = false,
): string {
  return `<div class="sd-f${wide ? ' wide' : ''}"><label for="${key}">${esc(label)}${required ? ' <span class="sd-req" aria-hidden="true">*</span>' : ''}</label>${control}${error ? `<small class="sd-err" id="${key}-err">${icon('alert')}${esc(error)}</small>` : ''}</div>`;
}

function sourceCard(
  m: MapStrings,
  ui: CartographyUi,
  summary: MapSummary,
  h: ScanViewHelpers,
  source: MapSource,
  index: number,
  issues: SourceIssues,
): string {
  const scan = summary.scan;
  const scanned = scan?.sources.find((s) => s.sourceId === source.id);
  const saved = summary.config.sources[index];
  const dirty = normalize(saved) !== normalize(source);
  const open = !ui.srcClosed.includes(index);
  const remote = source.kind === 'GIT';
  const name = source.name.trim() || m.sd.unnamed;
  const disabled = h.canEdit ? '' : 'disabled';
  const show = (key: SourceField, value: string): string | undefined =>
    issues[key] && (ui.srcTried || value.trim() !== '') ? issues[key] : undefined;
  const control = (key: SourceField, value: string, extra = '', required = false): string => {
    const id = `sd-${String(index)}-${key}`;
    const error = show(key, value);
    return `<input id="${id}" data-map="src-${key}" data-index="${String(index)}" value="${esc(value)}" ${disabled} autocomplete="off" spellcheck="false"${required ? ' aria-required="true"' : ''}${error ? ` aria-invalid="true" aria-describedby="${id}-err"` : ''} ${extra}>`;
  };
  const select = (key: string, value: string, options: [string, string][]): string =>
    `<select id="sd-${String(index)}-${key}" data-map="src-${key}" data-index="${String(index)}" ${disabled}>${options.map(([v, l]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const k = (key: string): string => `sd-${String(index)}-${key}`;
  const providerSelect = select('provider', source.provider ?? '', [
    ['', m.gs.providerAuto],
    ...GIT_PROVIDERS.map((p): [string, string] => [p, m.gs.providers[p] ?? p]),
  ]);
  const kindError = issues.kind;
  const body = open
    ? `<div class="sd-src-b" id="sd-src-b-${String(index)}"><div class="sd-grid3">${field(m.srcField.id, control('id', source.id, 'maxlength="40"', true), k('id'), show('id', source.id), true)}${field(m.srcField.name, control('name', source.name, 'maxlength="80"', true), k('name'), show('name', source.name), true)}${field(
        m.srcField.layer,
        select(
          'layer',
          source.layer,
          LAYERS.map((l): [string, string] => [l, m.layers[l] ?? l]),
        ),
        k('layer'),
        undefined,
        true,
      )}</div><div class="sd-grid2">${field(
        m.gs.kind,
        select('kind', remote ? 'GIT' : 'LOCAL', [
          ['LOCAL', m.gs.kinds.LOCAL ?? 'LOCAL'],
          ['GIT', m.gs.kinds.GIT ?? 'GIT'],
        ]),
        k('kind'),
        kindError,
        true,
      )}${
        remote
          ? field(
              m.gs.repoUrl,
              control(
                'repoUrl',
                source.repoUrl ?? '',
                'class="mono" maxlength="500" placeholder="https://"',
                true,
              ),
              k('repoUrl'),
              show('repoUrl', source.repoUrl ?? ''),
              true,
            )
          : field(
              m.srcField.path,
              control('path', source.path, 'class="mono"', true),
              k('path'),
              show('path', source.path),
              true,
            )
      }</div><div class="sd-grid2">${
        remote
          ? `${field(m.gs.branch, control('branch', source.branch ?? '', 'class="mono" maxlength="200"'), k('branch'), show('branch', source.branch ?? ''))}${field(m.gs.commit, control('commit', source.commit ?? '', 'class="mono" maxlength="64"'), k('commit'), show('commit', source.commit ?? ''))}${field(m.gs.tokenEnv, control('tokenEnv', source.tokenEnv ?? '', 'class="mono" maxlength="100"'), k('tokenEnv'), show('tokenEnv', source.tokenEnv ?? ''))}${field(m.gs.provider, providerSelect, k('provider'), undefined)}`
          : `${field(m.gs.repoUrlLocal, control('repoUrl', source.repoUrl ?? '', 'class="mono" maxlength="500"'), k('repoUrl'), show('repoUrl', source.repoUrl ?? ''))}${field(m.gs.provider, providerSelect, k('provider'), undefined)}`
      }</div><div class="sd-grid2 end">${field(m.srcField.include, control('include', source.include.join(', ')), k('include'), show('include', source.include.join(', ')))}<label class="map-check"><input type="checkbox" data-map="src-enabled" data-index="${String(index)}" ${source.enabled ? 'checked' : ''} ${disabled}> ${esc(m.srcField.enabled)}</label></div>${
        scanned
          ? `<p class="sd-src-f">${icon('file')}<span>${esc(m.files(scanned.files))}</span>${scanned.revision ? `${icon('merge')}<span class="mono">${esc(m.sd.revisionShort(scanned.revision))}</span>` : scanned.revisionStatus === 'UNDETERMINED' ? `${icon('merge')}<span>${esc(m.gs.undetermined)}</span>` : ''}${icon('history')}<span>${esc(m.sd.scannedAt(h.date(scan?.finishedAt ?? scan?.startedAt)))}</span>${h.chip(scanned.state, m.sourceState[scanned.state] ?? scanned.state)}</p>`
          : ''
      }</div>`
    : '';
  const hint = tokenHint(m, source, scanned);
  const problems =
    scanned?.errors.filter((e) => !/\[(CREDENTIALS_MISSING|AUTH_FAILED)\]/.test(e)).slice(0, 3) ?? [];
  const alerts =
    hint || problems.length
      ? `<ul class="sd-alerts" role="list">${hint ? `<li class="warn-t">${icon('alert')}<span>${esc(hint)}</span></li>` : ''}${problems.map((p) => `<li class="warn-t">${icon('alert')}<span>${esc(p)}</span></li>`).join('')}</ul>`
      : '';
  const status = dirty
    ? h.chip('PROPOSED', m.sd.notSaved)
    : scanned
      ? h.chip(scanned.state, m.sourceState[scanned.state] ?? scanned.state)
      : h.chip('NEVER', m.sd.neverScanned);
  const menu = h.canEdit
    ? `<details class="sd-menu"><summary class="btn small ghost icon-only" aria-label="${esc(m.sd.actions(name))}" title="${esc(m.sd.actions(name))}">${icon('more')}</summary><div class="sd-menu-l" role="menu"><button role="menuitem" class="sd-menu-i danger" data-action="map-src-remove" data-index="${String(index)}">${icon('trash')}<span>${esc(m.sd.remove)}</span></button></div></details>`
    : '';
  return `<li class="sd-src${open ? ' open' : ''}" id="sd-src-${String(index)}"><div class="sd-src-h"><button class="sd-tg" data-action="map-src-toggle" data-index="${String(index)}" aria-expanded="${String(open)}" aria-controls="sd-src-b-${String(index)}" aria-label="${esc(m.sd.toggle(name))}">${icon(open ? 'down' : 'right')}</button><span class="sd-src-ic l-${esc(source.layer.toLowerCase())}">${icon(LAYER_ICON[source.layer] ?? 'layers')}</span><span class="sd-src-t"><b>${esc(name)}</b>${h.layerChip(source.layer)}<span class="sd-kind">${icon(remote ? 'merge' : 'projects')}${esc(m.gs.kinds[remote ? 'GIT' : 'LOCAL'] ?? '')}</span></span>${status}${menu}</div>${alerts}${body}</li>`;
}

function sourcesPanel(m: MapStrings, ui: CartographyUi, summary: MapSummary, h: ScanViewHelpers): string {
  const sources = ui.sources ?? summary.config.sources;
  const issues = sourceIssues(m, sources, summary.gitHosts);
  const count = issueCount(issues);
  const git = Boolean(summary.gitHosts?.length);
  const add = h.canEdit
    ? `<details class="sd-menu sd-add"><summary class="btn primary small">${icon('plus')}<span>${esc(m.addSource)}</span>${icon('down')}</summary><div class="sd-menu-l right" role="menu"><button role="menuitem" class="sd-menu-i" data-action="map-src-add" data-kind="LOCAL">${icon('projects')}<span>${esc(m.sd.addLocal)}</span></button><button role="menuitem" class="sd-menu-i" data-action="map-src-add" data-kind="GIT" ${git ? '' : `disabled aria-disabled="true" title="${esc(m.gs.disabled)}"`}>${icon('merge')}<span>${esc(m.sd.addGit)}${git ? '' : ` — ${esc(m.sd.gitOff)}`}</span></button></div></details>`
    : '';
  const roots = summary.allowedRoots.length
    ? summary.allowedRoots.map((r) => `<code>${esc(r)}</code>`).join(' ')
    : '—';
  const info = `<p class="mu small">${esc(m.sd.sourcesSub)}</p><p class="mu small">${esc(m.allowedRoots)} : ${roots}</p><p class="mu small">${esc(git ? m.gs.hosts(summary.gitHosts?.join(', ') ?? '') : m.gs.disabled)}${git ? ` · ${esc(m.gs.tokenNote)}` : ''}</p>`;
  const list = sources.length
    ? `<ul class="sd-src-l">${sources.map((s, i) => sourceCard(m, ui, summary, h, s, i, issues[i] ?? {})).join('')}</ul>`
    : `<p class="mu sd-empty">${esc(m.sd.noSources)}</p>`;
  const errors =
    ui.srcTried && count > 0
      ? `<p class="err" role="alert">${icon('alert')}${esc(m.sd.fixErrors(count))}</p>`
      : '';
  const save = h.canEdit
    ? `<div class="form-acts start"><button class="btn primary" data-action="map-src-save" ${ui.sourcesBusy ? 'disabled' : ''}>${icon('save')}<span>${esc(m.saveSources)}</span></button><small class="mu">${esc(m.sd.requiredNote)}</small></div>`
    : '';
  const runnable = summary.allowedRoots.length > 0 || git;
  const run =
    h.canRun && runnable
      ? `<div class="sd-run"><label class="map-check"><input type="checkbox" data-map="incremental" ${ui.incremental ? 'checked' : ''}> ${esc(m.incremental)}</label>${summary.running ? `<button class="btn" data-action="map-scan-cancel">${icon('stop')}<span>${esc(m.cancelScan)}</span></button>` : `<button class="btn primary" data-action="map-scan" ${summary.config.sources.length === 0 ? 'disabled' : ''}>${icon('play')}<span>${esc(m.launchScan)}</span></button>`}</div>`
      : '';
  return `<section class="card sd-sources"><div class="sd-h"><h2>${icon('layers')}<span>${esc(m.sourcesEditor)}</span></h2><span class="pill mu">${esc(m.sd.count(sources.length))}</span>${add}</div>${info}${list}${errors}${save}${h.paneError(ui.sourcesError)}${run}</section>`;
}

const durationOf = (scan: ScanRecord): string | undefined => {
  if (!scan.finishedAt) return undefined;
  const ms = Date.parse(scan.finishedAt) - Date.parse(scan.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${String(s)} s` : `${String(Math.floor(s / 60))} min ${String(s % 60).padStart(2, '0')} s`;
};

const READ = new Set(['SCANNED', 'PARTIAL', 'REUSED']);

function lastScanCard(m: MapStrings, summary: MapSummary, h: ScanViewHelpers): string {
  const scan = summary.running ?? summary.scan;
  if (!scan)
    return `<section class="card sd-last"><div class="sd-h"><h2>${icon('scan')}<span>${esc(m.sd.lastScan)}</span></h2></div><p class="mu">${esc(m.sd.noScan)}</p></section>`;
  const active = scan.sources.filter((s) => s.state !== 'DISABLED');
  const read = active.filter((s) => READ.has(s.state)).length;
  const enabled = summary.config.sources.filter((s) => s.enabled).length;
  const running = scan.state === 'RUNNING';
  const failed = scan.state === 'FAILED';
  const steps: { key: string; state: 'done' | 'running' | 'failed' | 'waiting'; sub?: string }[] = [
    {
      key: 'read',
      state: running ? 'running' : read === 0 && active.length > 0 ? 'failed' : 'done',
      sub: m.sd.readOf(read, running ? enabled : active.length),
    },
    { key: 'graph', state: running ? 'waiting' : failed ? 'failed' : 'done' },
    { key: 'save', state: running ? 'waiting' : scan.state === 'CANCELLED' || failed ? 'failed' : 'done' },
  ];
  const mark = { done: 'check', running: 'refresh', failed: 'close', waiting: 'minus' } as const;
  const duration = durationOf(scan);
  return `<section class="card sd-last"><div class="sd-h"><h2>${icon('scan')}<span>${esc(m.sd.lastScan)}</span></h2>${h.chip(scan.state, m.scanState[scan.state] ?? scan.state)}</div><p class="sd-meta">${icon('history')}<span>${esc(h.date(scan.startedAt))}</span>${duration ? `<span class="mu">· ${esc(m.sd.duration(duration))}</span>` : ''}</p><ol class="sd-steps">${steps
    .map(
      (step) =>
        `<li class="st-${step.state}"><span class="sd-dot" aria-hidden="true">${icon(mark[step.state])}</span><span><b>${esc(m.sd.steps[step.key] ?? step.key)}</b><small>${esc(step.sub ?? m.sd.stepState[step.state] ?? '')}</small></span></li>`,
    )
    .join('')}</ol></section>`;
}

function summaryCard(m: MapStrings, summary: MapSummary, h: ScanViewHelpers): string {
  const scan = summary.running ?? summary.scan;
  if (!scan?.sources.length) return '';
  const rows = scan.sources
    .map((s) => {
      const first = s.errors[0];
      return `<li><button class="sd-row" data-action="map-src-focus" data-id="${esc(s.sourceId)}" aria-label="${esc(m.sd.openSource(s.name))}"><span class="sd-src-ic l-${esc(s.layer.toLowerCase())}">${icon(LAYER_ICON[s.layer] ?? 'layers')}</span><span class="sd-row-t"><span class="sd-line"><b>${esc(s.name)}</b>${h.layerChip(s.layer)}</span><small>${esc([m.files(s.files), s.kind === 'GIT' ? m.gs.kinds.GIT : m.gs.kinds.LOCAL, s.revision ? m.sd.revisionShort(s.revision) : s.revisionStatus === 'UNDETERMINED' ? m.gs.undetermined : ''].filter(Boolean).join(' · '))}</small>${first ? `<small class="warn-t">${esc(first)}</small>` : ''}</span>${h.chip(s.state, m.sourceState[s.state] ?? s.state)}${icon('right')}</button></li>`;
    })
    .join('');
  return `<section class="card sd-sum" id="map-scan-summary" tabindex="-1"><div class="sd-h"><h2>${icon('grid')}<span>${esc(m.sd.summaryTitle)}</span></h2></div><ul class="sd-rows">${rows}</ul></section>`;
}

const NAV: Record<string, string> = {
  FEATURE: 'features',
  FIELD: 'fields',
  API: 'apis',
  CONTAINER: 'structure',
  BUTTON: 'structure',
  CONDITION: 'structure',
};

function foundCard(m: MapStrings, summary: MapSummary): string {
  const scan = summary.scan;
  if (!scan) return '';
  const entries = Object.entries(scan.counts)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0)
    .sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, v]) => v));
  const rows = entries
    .map(([kind, value]) => {
      const label = `${m.sd.kindNames[kind] ?? kind} (${String(value)})`;
      const bar = `<span class="sd-bar" aria-hidden="true"><i style="width:${String(Math.max(4, Math.round((value / max) * 100)))}%"></i></span>`;
      const tab = NAV[kind];
      return tab
        ? `<li><button class="sd-row" data-action="map-tab" data-tab="${tab}" aria-label="${esc(m.sd.open(label))}"><span class="sd-row-t">${esc(label)}</span>${bar}${icon('right')}</button></li>`
        : `<li><span class="sd-row static"><span class="sd-row-t">${esc(label)}</span>${bar}<span class="sd-sp"></span></span></li>`;
    })
    .join('');
  return `<section class="card sd-found"><div class="sd-h"><h2>${icon('data')}<span>${esc(m.sd.foundTitle)}</span></h2></div>${rows ? `<ul class="sd-rows">${rows}</ul>` : `<p class="mu">${esc(m.sd.foundNone)}</p>`}</section>`;
}

function recentCard(m: MapStrings, ui: CartographyUi, summary: MapSummary, h: ScanViewHelpers): string {
  const scans = summary.scans;
  const shown = ui.scansAll ? scans : scans.slice(0, 3);
  const latest = scans[0]?.id;
  const rows = shown
    .map(
      (s) =>
        `<li class="sd-scanrow${s.id === summary.scan?.id ? ' current' : ''}">${h.chip(s.state, m.scanState[s.state] ?? s.state)}<span class="sd-row-t"><b>${esc(h.date(s.startedAt))}</b><small>${esc([s.incremental ? m.incrementalShort : '', m.edgesCount(s.edges)].filter(Boolean).join(' · '))}</small></span>${s.id !== latest ? `<button class="btn small ghost icon-only" data-action="map-scan-compare" data-id="${esc(s.id)}" aria-label="${esc(m.sd.compareLatest)}" title="${esc(m.sd.compareLatest)}">${icon('swap')}</button>` : ''}</li>`,
    )
    .join('');
  const toggle =
    scans.length > 3
      ? `<button class="lnk" data-action="map-scans-all" aria-expanded="${String(ui.scansAll)}">${esc(ui.scansAll ? m.sd.seeLess : m.sd.seeAll)}</button>`
      : '';
  return `<section class="card sd-recent"><div class="sd-h"><h2>${icon('history')}<span>${esc(m.sd.recentTitle(scans.length))}</span></h2>${toggle}</div>${rows ? `<ul class="sd-rows">${rows}</ul>` : `<p class="mu">${esc(m.noHistory)}</p>`}</section>`;
}

function coverageCard(m: MapStrings, summary: MapSummary): string {
  const c = summary.coverage;
  const percent = c.percent;
  return `<section class="card sd-cov"><div class="sd-h"><h2>${icon('target')}<span>${esc(m.sd.coverageTitle)}</span></h2></div><button class="sd-row" data-action="map-tab" data-tab="coverage" title="${esc(c.formula)}"><span class="sd-big">${percent === undefined ? '—' : `${String(percent)} %`}</span><span class="sd-row-t"><small>${esc(percent === undefined ? m.sd.notComputable : m.sd.coverageOf(c.numerator, c.denominator))}</small></span>${icon('right')}</button><span class="sd-bar wide" role="img" aria-label="${esc(percent === undefined ? m.sd.notComputable : `${String(percent)} %`)}"><i style="width:${String(percent ?? 0)}%"></i></span></section>`;
}

export function scanView(m: MapStrings, ui: CartographyUi, summary: MapSummary, h: ScanViewHelpers): string {
  return `<div class="sd-scan">${sourcesPanel(m, ui, summary, h)}<div class="sd-side">${lastScanCard(m, summary, h)}${summaryCard(m, summary, h)}${foundCard(m, summary)}${recentCard(m, ui, summary, h)}${coverageCard(m, summary)}</div></div>`;
}

// ── Analyse d'impact ──────────────────────────────────────────────────────────────────────────────

export type RowKind = 'ADDED' | 'REMOVED' | 'CHANGED' | 'UNCHANGED' | 'UNDETERMINED';
export interface ImpactRow {
  kind: RowKind;
  name: string;
  nodeKind?: string;
  source?: string;
  sourceName?: string;
  layer?: string;
  impact: 'FEATURES' | 'NONE_SHOWN' | 'NONE' | 'CHECK';
  features: { id: string; name: string }[];
  details: string;
  change?: MapChange;
}

/** Les lignes du tableau : un changement par élément, puis les sources inchangées ou indéterminées. */
export function impactRows(m: MapStrings, report: ImpactReport): ImpactRow[] {
  const sources = new Map((report.sources ?? []).map((s) => [s.sourceId, s]));
  const rows: ImpactRow[] = report.changes.map((change) => ({
    kind: change.change,
    name: change.name,
    nodeKind: change.kind,
    ...(change.source
      ? { source: change.source, sourceName: sources.get(change.source)?.name ?? change.source }
      : {}),
    ...(change.layer ? { layer: change.layer } : {}),
    impact: change.features?.length ? 'FEATURES' : 'NONE_SHOWN',
    features: change.features ?? [],
    details: change.detail.join(' · '),
    change,
  }));
  for (const s of report.sources ?? [])
    if (s.status === 'UNCHANGED' || s.status === 'UNDETERMINED')
      rows.push({
        kind: s.status,
        name: s.name,
        source: s.sourceId,
        sourceName: s.name,
        layer: s.layer,
        impact: s.status === 'UNCHANGED' ? 'NONE' : 'CHECK',
        features: [],
        details: `${s.reason} · ${m.sd.sourceCounts(s.changes.added, s.changes.removed, s.changes.changed)}`,
      });
  return rows;
}

/** Les lignes retenues par les critères (type, couche, source, recherche). */
export function filterRows(
  rows: readonly ImpactRow[],
  ui: Pick<CartographyUi, 'impactKind' | 'impactLayer' | 'impactSource' | 'impactQ'>,
): ImpactRow[] {
  const q = ui.impactQ.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (ui.impactKind === 'ALL' || r.kind === ui.impactKind) &&
      (!ui.impactLayer || r.layer === ui.impactLayer) &&
      (!ui.impactSource || r.source === ui.impactSource) &&
      (!q ||
        [
          r.name,
          r.sourceName ?? '',
          r.details,
          r.change?.evidence?.file ?? '',
          ...r.features.map((f) => f.name),
        ]
          .join(' ')
          .toLowerCase()
          .includes(q)),
  );
}

const KIND_CLASS: Record<RowKind, string> = {
  ADDED: 'added',
  REMOVED: 'removed',
  CHANGED: 'changed',
  UNCHANGED: 'unchanged',
  UNDETERMINED: 'undetermined',
};

function ring(m: MapStrings, a: number, r: number, c: number, u: number, d: number): string {
  const total = a + r + c + u + d;
  const radius = 42;
  const length = 2 * Math.PI * radius;
  let offset = 0;
  const segments = (
    [
      ['added', a],
      ['removed', r],
      ['changed', c],
      ['unchanged', u],
      ['undetermined', d],
    ] as const
  )
    .filter(([, v]) => v > 0)
    .map(([cls, v]) => {
      const dash = (v / total) * length;
      const out = `<circle class="sd-seg ${cls}" r="${String(radius)}" cx="55" cy="55" stroke-dasharray="${dash.toFixed(2)} ${(length - dash).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}"/>`;
      offset += dash;
      return out;
    })
    .join('');
  const changes = a + r + c;
  const center =
    d > 0 && changes === 0
      ? `<text x="55" y="54" class="sd-ring-n">?</text><text x="55" y="70" class="sd-ring-l">${esc(m.sd.incomplete)}</text>`
      : `<text x="55" y="56" class="sd-ring-n">${String(changes)}</text><text x="55" y="72" class="sd-ring-l">${esc(m.sd.centerChanges(changes))}</text>`;
  return `<svg class="sd-ring" viewBox="0 0 110 110" role="img" aria-label="${esc(m.sd.ringLabel(a, r, c, u, d))}"><circle class="sd-seg base" r="${String(radius)}" cx="55" cy="55"/>${segments}${center}</svg>`;
}

export interface ImpactExtras {
  launch: string;
}

export function impactView(
  m: MapStrings,
  ui: CartographyUi,
  summary: MapSummary,
  h: ScanViewHelpers,
  extras: ImpactExtras,
): string {
  const scans = summary.scans;
  if (scans.length < 2)
    return `<section class="card sd-cmp"><div class="sd-h"><h2>${icon('target')}<span>${esc(m.impactTitle)}</span></h2></div><p class="mu">${esc(m.impactNeedTwo)}</p></section>`;
  const from = ui.impactFrom || scans[1]?.id || '';
  const to = ui.impactTo || scans[0]?.id || '';
  const option = (id: string, selected: string): string => {
    const s = scans.find((x) => x.id === id);
    return `<option value="${esc(id)}" ${id === selected ? 'selected' : ''}>${esc(s ? `${h.date(s.startedAt)} · ${m.scanState[s.state] ?? s.state}` : id)}</option>`;
  };
  const same = from === to;
  const picker = (key: 'from' | 'to', label: string, value: string): string =>
    `<label class="sd-pick"><span>${esc(label)}</span><span class="sd-pick-c">${icon('history')}<select data-map="impact-${key}" aria-label="${esc(label)}">${scans.map((s) => option(s.id, value)).join('')}</select></span></label>`;
  const head = `<section class="card sd-cmp"><div class="sd-h"><h2>${icon('target')}<span>${esc(m.impactTitle)}</span></h2></div><p class="mu small">${esc(m.sd.impactSub)}</p><div class="sd-cmp-r">${picker('from', m.impactFrom, from)}<button class="btn icon-only" data-action="map-impact-swap" aria-label="${esc(m.sd.swap)}" title="${esc(m.sd.swap)}">${icon('swap')}</button>${picker('to', m.impactTo, to)}<button class="btn primary" data-action="map-impact" ${ui.impactBusy || same ? 'disabled' : ''}>${icon('search')}<span>${esc(m.impactRun)}</span></button></div>${same ? `<p class="warn-t small" role="alert">${esc(m.sd.same)}</p>` : ''}<p class="mu small">${icon('info')} ${esc(m.limitNote)}</p>${h.paneError(ui.impactError)}</section>`;
  const report = ui.impact;
  if (!report)
    return `${head}<section class="card"><p class="mu">${esc(ui.impactBusy ? m.sd.comparing : m.sd.notCompared)}</p></section>`;
  const sources = report.sources ?? [];
  const a = report.changes.filter((c) => c.change === 'ADDED').length;
  const r = report.changes.filter((c) => c.change === 'REMOVED').length;
  const c = report.changes.filter((x) => x.change === 'CHANGED').length;
  const u = sources.filter((s) => s.status === 'UNCHANGED').length;
  const d = sources.filter((s) => s.status === 'UNDETERMINED').length;
  const statusIcon: Record<string, string> = {
    UNCHANGED: 'check',
    UNDETERMINED: 'alert',
    MODIFIED: 'edit',
    ADDED: 'plus',
    REMOVED: 'minus',
  };
  const sourceList = sources.length
    ? `<ul class="sd-rows">${sources
        .map(
          (s) =>
            `<li><span class="sd-row static"><span class="sd-type t-${(KIND_CLASS as Record<string, string>)[s.status] ?? (s.status === 'MODIFIED' ? 'changed' : s.status.toLowerCase())}">${esc(m.sd.sourceRow[s.status] ?? s.status)}</span><span class="sd-row-t"><span class="sd-line"><b>${esc(s.name)}</b>${h.layerChip(s.layer)}</span><small class="mono">${esc(`${s.from?.revision?.slice(0, 8) ?? '—'} → ${s.to?.revision?.slice(0, 8) ?? '—'}`)}</small><small>${esc(m.sd.sourceCounts(s.changes.added, s.changes.removed, s.changes.changed))}</small></span><span class="sd-st ${s.status === 'UNDETERMINED' ? 'warn' : 'ok'}" aria-hidden="true">${icon(statusIcon[s.status] ?? 'info')}</span></span></li>`,
        )
        .join('')}</ul>`
    : `<p class="mu small">—</p>`;
  const legend = (
    [
      ['added', m.sd.added, a],
      ['removed', m.sd.removed, r],
      ['changed', m.sd.changed, c],
      ['unchanged', m.sd.unchanged, u],
      ['undetermined', m.sd.undetermined, d],
    ] as const
  )
    .map(
      ([cls, label, v]) =>
        `<li><i class="sd-lg ${cls}" aria-hidden="true"></i>${esc(label)}<b>${String(v)}</b></li>`,
    )
    .join('');
  const row3 = `<div class="sd-imp-r"><section class="card"><div class="sd-h"><h2>${icon('layers')}<span>${esc(m.sd.sourcesCompared(sources.length))}</span></h2><button class="btn small ghost" data-action="map-impact-detail">${esc(m.sd.seeDetail)}${icon('right')}</button></div>${sourceList}</section><section class="card"><div class="sd-h"><h2>${icon('swap')}<span>${esc(m.sd.changesTitle)}</span></h2></div><div class="sd-ring-w">${ring(m, a, r, c, u, d)}<ul class="sd-legend">${legend}</ul></div></section><div class="sd-tiles"><button class="sd-tile ok" data-action="map-focus" data-target="sd-imp-features"><span>${icon('cube')}</span><span><small>${esc(m.sd.featuresTouched)}</small><b>${String(report.features.length)}</b></span></button><button class="sd-tile vi" data-action="map-focus" data-target="sd-imp-scenarios"><span>${icon('play')}</span><span><small>${esc(m.sd.toReplay)}</small><b>${String(report.scenarios.length)}</b></span></button></div></div>`;
  const all = impactRows(m, report);
  const shown = filterRows(all, ui);
  const counts: Record<string, number> = { ALL: all.length };
  for (const row of all) counts[row.kind] = (counts[row.kind] ?? 0) + 1;
  const kinds: [string, string, string][] = [
    ['ALL', m.sd.all, 'all'],
    ['ADDED', m.sd.added, 'added'],
    ['REMOVED', m.sd.removed, 'removed'],
    ['CHANGED', m.sd.changed, 'changed'],
    ['UNCHANGED', m.sd.unchanged, 'unchanged'],
    ['UNDETERMINED', m.sd.undetermined, 'undetermined'],
  ];
  const chips = `<div class="sd-chips" role="group" aria-label="${esc(m.sd.cols.type ?? '')}">${kinds
    .map(
      ([kind, label, cls]) =>
        `<button class="sd-chip ${cls}" data-action="map-impact-kind" data-kind="${kind}" aria-pressed="${String(ui.impactKind === kind)}">${esc(label)} (${String(counts[kind] ?? 0)})</button>`,
    )
    .join('')}</div>`;
  const layers = [...new Set(all.map((x) => x.layer).filter((x): x is string => Boolean(x)))];
  const sourceOptions = [
    ...new Map(
      all.filter((x) => x.source).map((x) => [x.source ?? '', x.sourceName ?? x.source ?? '']),
    ).entries(),
  ];
  const filters = ui.showImpactFilters
    ? `<div class="sd-filters"><label class="pick">${esc(m.sd.cols.layer ?? '')} <select data-map="imp-layer"><option value="">${esc(m.sd.layerAll)}</option>${layers.map((l) => `<option value="${esc(l)}" ${ui.impactLayer === l ? 'selected' : ''}>${esc(m.layers[l] ?? l)}</option>`).join('')}</select></label><label class="pick">${esc(m.sd.cols.source ?? '')} <select data-map="imp-source"><option value="">${esc(m.sd.sourceAll)}</option>${sourceOptions.map(([id, name]) => `<option value="${esc(id)}" ${ui.impactSource === id ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select></label></div>`
    : '';
  const limit = ui.impactLimit;
  const impactCell = (row: ImpactRow): string =>
    row.impact === 'FEATURES'
      ? `<span class="sd-imp warn">${esc(m.sd.impactFeatures(row.features.length))}</span>`
      : row.impact === 'CHECK'
        ? `<span class="sd-imp warn">${icon('alert')}${esc(m.sd.impactCheck)}</span>`
        : row.impact === 'NONE'
          ? `<span class="sd-imp mu">${esc(m.sd.impactNo)}</span>`
          : `<span class="sd-imp mu">${esc(m.sd.impactNone)}</span>`;
  const menuOf = (row: ImpactRow): string => {
    const items = [
      row.change?.evidence ? h.evidence(row.change.evidence) : '',
      ...row.features
        .slice(0, 5)
        .map(
          (f) =>
            `<button role="menuitem" class="sd-menu-i" data-action="map-feature" data-feature="${esc(f.id)}">${icon('cube')}<span>${esc(m.sd.openFeature(f.name))}</span></button>`,
        ),
    ].filter(Boolean);
    return items.length
      ? `<details class="sd-menu"><summary class="btn small ghost icon-only" aria-label="${esc(m.sd.rowActions(row.name))}">${icon('more')}</summary><div class="sd-menu-l right" role="menu">${items.join('')}</div></details>`
      : '';
  };
  const body = shown
    .slice(0, limit)
    .map(
      (row) =>
        `<tr><td><span class="sd-type t-${KIND_CLASS[row.kind]}">${esc(m.sd.rowKind[row.kind] ?? row.kind)}</span></td><td><b>${esc(row.name)}</b>${row.nodeKind ? `<br><small class="mu">${esc(row.nodeKind)}</small>` : ''}</td><td>${esc(row.sourceName ?? '—')}</td><td>${row.layer ? h.layerChip(row.layer) : '—'}</td><td>${impactCell(row)}</td><td class="small">${esc(row.details || '—')}</td><td>${menuOf(row)}</td></tr>`,
    )
    .join('');
  const message =
    a + r + c === 0
      ? `<p class="${d > 0 ? 'warn-t' : 'mu'} small" role="status">${esc(d > 0 ? m.sd.noChangeRead(d) : m.sd.noChange)}</p>`
      : '';
  const table = `<section class="card sd-detail" id="sd-imp-detail" tabindex="-1"><div class="sd-h"><h2>${icon('menu')}<span>${esc(m.sd.detailTitle)}</span></h2><label class="sd-search">${icon('search')}<input type="search" data-map="imp-q" value="${esc(ui.impactQ)}" placeholder="${esc(m.sd.search)}" aria-label="${esc(m.sd.search)}"></label><button class="btn small" data-action="map-impact-filters" aria-expanded="${String(Boolean(ui.showImpactFilters))}">${icon('filter')}<span>${esc(m.sd.filters)}</span></button></div>${chips}${filters}${message}<div class="tbl-w"><table class="tbl sd-tbl"><thead><tr>${['type', 'element', 'source', 'layer', 'impact', 'details'].map((col) => `<th scope="col">${esc(m.sd.cols[col] ?? col)}</th>`).join('')}<th scope="col"><span class="sr">${esc(m.sd.rowActions(''))}</span></th></tr></thead><tbody>${body || `<tr><td colspan="7" class="mu">${esc(m.sd.noRows)}</td></tr>`}</tbody></table></div>${shown.length > limit ? `<button class="btn small ghost" data-action="map-impact-more">${esc(m.sd.more(shown.length - limit))}</button>` : ''}</section>`;
  const features = report.features
    .map(
      (f) =>
        `<li>${h.conf(f.confidence)} <button class="lnk" data-action="map-feature" data-feature="${esc(f.feature)}">${esc(f.name)}</button><ul class="map-why">${f.via
          .slice(0, 4)
          .map((v) => `<li>${esc(v)}</li>`)
          .join('')}</ul></li>`,
    )
    .join('');
  const scenarios = report.scenarios
    .map(
      (s) =>
        `<li><label class="map-pickrow"><input type="checkbox" data-map="impact-pick" data-scenario="${esc(s.scenario)}" ${ui.impactPicked.includes(s.scenario) ? 'checked' : ''}> <b>${esc(s.scenario)}</b> ${h.conf(s.confidence)}</label><small class="mu">${esc(s.reason)}</small></li>`,
    )
    .join('');
  const identical =
    report.from === report.to ? `<p class="map-note warn-t" role="note">${esc(m.sd.identical)}</p>` : '';
  return `${head}${identical}<div class="map-impact sd-impw">${row3}${table}<div class="sd-imp-r2"><section class="card" id="sd-imp-features" tabindex="-1"><h2>${esc(m.impacted(report.features.length))}</h2>${features ? `<ul class="map-imp-l">${features}</ul>` : `<p class="mu small">—</p>`}</section><section class="card" id="sd-imp-scenarios" tabindex="-1"><h2>${esc(m.toReplay(report.scenarios.length))}</h2>${scenarios ? `<ul class="map-imp-l">${scenarios}</ul>` : `<p class="mu small">—</p>`}${extras.launch}</section></div></div>`;
}

export const SCAN_CSS = `
.sd-scan{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(300px,1fr);gap:14px;align-items:start}
@media (max-width:1100px){.sd-scan{grid-template-columns:minmax(0,1fr)}}
.sd-side{display:flex;flex-direction:column;gap:14px;min-width:0}
.sd-sources,.sd-side>.card{min-width:0}
.sd-sources>p.mu,.sd-cmp>p.mu{margin:2px 0}
.sd-line{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.sd-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}.sd-h h2{display:flex;align-items:center;gap:8px;margin:0;font-size:15px;flex:1 1 auto;min-width:0}.sd-h h2 .ico{width:18px;height:18px;color:var(--qa-color-primary,#15803d)}
.sd-src-l{list-style:none;margin:10px 0 0;padding:0;display:flex;flex-direction:column;gap:10px}
.sd-src{border:1px solid var(--qa-color-border);border-radius:12px;background:var(--qa-color-surface);overflow:visible}
.sd-src-h{display:flex;align-items:center;gap:8px;padding:8px 10px;flex-wrap:wrap}
.sd-tg{border:0;background:transparent;cursor:pointer;padding:4px;border-radius:6px;color:var(--qa-color-muted)}.sd-tg .ico{width:14px;height:14px}
.sd-tg:focus-visible,.sd-row:focus-visible,.sd-chip:focus-visible,.sd-tile:focus-visible{outline:2px solid var(--qa-color-primary,#15803d);outline-offset:2px}
.sd-src-ic{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:8px;background:var(--qa-color-surface-2);flex:none}.sd-src-ic .ico{width:15px;height:15px}
.sd-src-ic.l-frontend{color:#be123c;background:#fdecef}.sd-src-ic.l-bff{color:#15803d;background:#e8f5ec}.sd-src-ic.l-backend{color:#2563eb;background:#eef4fd}
.sd-src-t{display:flex;align-items:center;gap:6px;flex:1 1 auto;min-width:0;flex-wrap:wrap}.sd-src-t b{font-size:14px;overflow-wrap:anywhere}
.sd-kind{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;color:var(--qa-color-muted);border:1px solid var(--qa-color-border);border-radius:999px;padding:1px 8px}.sd-kind .ico{width:12px;height:12px}
.sd-src-b{padding:4px 12px 12px;display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--qa-color-border)}
.sd-grid3{display:grid;grid-template-columns:minmax(0,.8fr) minmax(0,1.2fr) minmax(0,1fr);gap:10px}
.sd-grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.sd-grid2.end{align-items:end}
@media (max-width:700px){.sd-grid3,.sd-grid2{grid-template-columns:minmax(0,1fr)}}
.sd-f{display:flex;flex-direction:column;gap:4px;min-width:0}.sd-f label{font-size:12.5px;font-weight:600}
.sd-f input,.sd-f select{font:inherit;padding:6px 8px;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-surface);min-width:0;width:100%;box-sizing:border-box}
.sd-f input.mono{font-family:var(--qa-font-mono,ui-monospace,monospace);font-size:12.5px}
.sd-f input[aria-invalid="true"]{border-color:#b91c1c;box-shadow:0 0 0 1px #b91c1c}
.sd-req{color:#b91c1c}
.sd-err{display:flex;gap:4px;align-items:flex-start;color:#b91c1c;font-size:12px}.sd-err .ico{width:13px;height:13px;flex:none;margin-top:1px}
.sd-src-f{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:var(--qa-color-muted);margin:0;padding-top:8px;border-top:1px dashed var(--qa-color-border)}.sd-src-f .ico{width:13px;height:13px}.sd-src-f .pill{margin-left:auto}
.sd-alerts{list-style:none;margin:0;padding:0 12px 8px;display:flex;flex-direction:column;gap:4px;font-size:12.5px}.sd-alerts li{display:flex;gap:6px;align-items:flex-start;overflow-wrap:anywhere}.sd-alerts .ico{width:14px;height:14px;flex:none;margin-top:2px}
.sd-menu{position:relative}.sd-menu>summary{list-style:none;cursor:pointer}.sd-menu>summary::-webkit-details-marker{display:none}
.sd-menu-l{position:absolute;z-index:20;top:calc(100% + 4px);right:0;min-width:200px;background:var(--qa-color-surface);border:1px solid var(--qa-color-border);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.12);padding:4px;display:flex;flex-direction:column}
.sd-menu-i{display:flex;gap:8px;align-items:center;border:0;background:transparent;padding:8px 10px;border-radius:8px;cursor:pointer;font:inherit;text-align:left;color:inherit}.sd-menu-i:hover{background:var(--qa-color-surface-2)}.sd-menu-i[disabled]{opacity:.55;cursor:not-allowed}.sd-menu-i.danger{color:#b91c1c}.sd-menu-i .ico{width:15px;height:15px}
.sd-menu-l .map-ev-btn{padding:8px 10px}
.sd-add>summary{display:inline-flex;gap:6px;align-items:center}
.sd-run{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:12px;padding-top:12px;border-top:1px solid var(--qa-color-border)}
.sd-empty{padding:16px 0}
.sd-meta{display:flex;gap:6px;align-items:center;margin:0 0 10px;font-size:12.5px}.sd-meta .ico{width:14px;height:14px}
.sd-steps{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
.sd-steps li{display:flex;gap:6px;align-items:flex-start;font-size:12px}.sd-steps small{display:block;color:var(--qa-color-muted)}
.sd-dot{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;flex:none;border:2px solid var(--qa-color-border);color:var(--qa-color-muted)}.sd-dot .ico{width:12px;height:12px}
.st-done .sd-dot{background:#15803d;border-color:#15803d;color:#fff}.st-failed .sd-dot{background:#b91c1c;border-color:#b91c1c;color:#fff}.st-running .sd-dot{border-color:#15803d;color:#15803d}
.sd-rows{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.sd-row{display:flex;align-items:center;gap:8px;width:100%;border:0;background:transparent;text-align:left;font:inherit;color:inherit;padding:7px 6px;border-radius:8px;cursor:pointer}.sd-row:hover{background:var(--qa-color-surface-2)}.sd-row.static{cursor:default}.sd-row.static:hover{background:transparent}
.sd-row>.ico{width:14px;height:14px;color:var(--qa-color-muted);flex:none}
.sd-row-t{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;font-size:13px}.sd-row-t small{color:var(--qa-color-muted);font-size:11.5px;overflow-wrap:anywhere}.sd-row-t small.warn-t{color:#b45309}
.sd-bar{display:block;width:90px;height:6px;border-radius:999px;background:var(--qa-color-surface-2);overflow:hidden;flex:none}.sd-bar i{display:block;height:100%;background:#15803d;border-radius:999px}.sd-bar.wide{width:100%;margin-top:6px}
.sd-sp{width:14px}
.sd-scanrow{display:flex;align-items:center;gap:8px;padding:6px}.sd-scanrow.current{background:var(--qa-color-primary-soft,#e8f5ec);border-radius:8px}
.sd-big{font-size:24px;font-weight:700}
.sd-cmp-r{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin:8px 0}
.sd-pick{display:flex;flex-direction:column;gap:4px;font-size:12.5px;font-weight:600;flex:1 1 220px;min-width:0}
.sd-pick-c{display:flex;align-items:center;gap:6px;border:1px solid var(--qa-color-border);border-radius:8px;padding:0 8px;background:var(--qa-color-surface)}.sd-pick-c .ico{width:14px;height:14px;color:var(--qa-color-muted)}.sd-pick-c select{border:0;background:transparent;font:inherit;padding:7px 0;flex:1;min-width:0}
.sd-imp-r{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr) minmax(200px,.7fr);gap:14px;align-items:stretch}
@media (max-width:1100px){.sd-imp-r{grid-template-columns:minmax(0,1fr)}}
.sd-imp-r2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
@media (max-width:860px){.sd-imp-r2{grid-template-columns:minmax(0,1fr)}}
.map-impact.sd-impw{display:flex;flex-direction:column;gap:14px;margin-top:14px;align-items:stretch}
.sd-type{display:inline-flex;align-items:center;font-size:11.5px;font-weight:600;padding:2px 8px;border-radius:999px;white-space:nowrap}
.t-added{background:#e8f5ec;color:#15803d}.t-removed{background:#fdecef;color:#be123c}.t-changed{background:#fef3c7;color:#92400e}.t-unchanged{background:#eef2f0;color:#3f6150}.t-undetermined{background:#fdf3e4;color:#b45309;border:1px dashed #b45309}
.sd-st .ico{width:16px;height:16px}.sd-st.ok{color:#15803d}.sd-st.warn{color:#b45309}
.sd-ring-w{display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.sd-ring{width:120px;height:120px;flex:none}.sd-seg{fill:none;stroke-width:12;transform:rotate(-90deg);transform-origin:55px 55px}.sd-seg.base{stroke:var(--qa-color-surface-2)}
.sd-seg.added{stroke:#15803d}.sd-seg.removed{stroke:#be123c}.sd-seg.changed{stroke:#d97706}.sd-seg.unchanged{stroke:#9ca3af}.sd-seg.undetermined{stroke:#f59e0b;stroke-dasharray:4 3}
.sd-ring-n{font-size:22px;font-weight:700;text-anchor:middle;fill:currentColor}.sd-ring-l{font-size:9px;text-anchor:middle;fill:var(--qa-color-muted)}
.sd-legend{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;font-size:12.5px;min-width:150px}.sd-legend li{display:flex;align-items:center;gap:8px}.sd-legend b{margin-left:auto}
.sd-lg{display:inline-block;width:10px;height:10px;border-radius:50%}.sd-lg.added{background:#15803d}.sd-lg.removed{background:#be123c}.sd-lg.changed{background:#d97706}.sd-lg.unchanged{background:#9ca3af}.sd-lg.undetermined{background:#f59e0b}
.sd-tiles{display:flex;flex-direction:column;gap:14px}
.sd-tile{display:flex;gap:12px;align-items:center;border:1px solid var(--qa-color-border);border-radius:12px;padding:14px;cursor:pointer;font:inherit;color:inherit;text-align:left;flex:1}
.sd-tile.ok{background:#f1f8f3}.sd-tile.vi{background:#f5f2fd}.sd-tile .ico{width:22px;height:22px}.sd-tile small{display:block;font-weight:600;font-size:12.5px}.sd-tile b{font-size:22px}
.sd-search{display:flex;align-items:center;gap:6px;border:1px solid var(--qa-color-border);border-radius:8px;padding:4px 8px;background:var(--qa-color-surface);flex:0 1 320px;min-width:0}.sd-search .ico{width:14px;height:14px;color:var(--qa-color-muted)}.sd-search input{border:0;outline:0;font:inherit;background:transparent;min-width:0;flex:1}
.sd-chips{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 8px}
.sd-chip{border:1px solid var(--qa-color-border);background:var(--qa-color-surface);border-radius:999px;padding:4px 10px;font:inherit;font-size:12.5px;cursor:pointer}
.sd-chip[aria-pressed="true"]{background:#15803d;border-color:#15803d;color:#fff}
.sd-filters{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px}
.sd-tbl td{vertical-align:top}.sd-tbl td .sd-menu-l{min-width:240px}
.sd-imp{display:inline-flex;gap:4px;align-items:center;margin:0;flex-direction:row}span.sd-imp.warn{color:#b45309}span.sd-imp.mu{color:var(--qa-color-muted)}span.sd-imp .ico{width:13px;height:13px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
`;
