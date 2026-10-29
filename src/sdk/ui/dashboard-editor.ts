import type {
  GeneratedFileDiagnostic,
  GeneratedFileView,
  GeneratedTestsView,
  GenerationFormatName,
  GenerationPreview,
  TestRunView,
} from '../core/contracts.js';
import { DIAGNOSTIC_CATEGORIES } from '../core/contracts.js';
import type { CodeOutlineEntry } from '../editor/code-outline.js';
import type { FlowGroupNode, FlowParse, FlowStepNode } from '../editor/flow-document.js';
import type { GherkinParse, GherkinStepNode } from '../editor/gherkin-document.js';
import { can } from './dashboard-access.js';
import { formatDate, icon, pill } from './dashboard-parts.js';
import type { DashboardState } from './dashboard-view.js';
import { esc } from './view.js';

/**
 * L'ÉDITEUR DES TESTS GÉNÉRÉS : un écran pour comprendre, modifier, vérifier, comparer et rejouer les
 * fichiers d'un enregistrement (flow YAML, Gherkin, Playwright TypeScript, Java JUnit 5). Quatre zones :
 * la barre (fichier, état, actions), l'explorateur (fichiers et plan), le centre (onglets, vue visuelle
 * ou source, comparaison, diagnostics et résultats) et l'inspecteur (l'étape choisie). La vue visuelle
 * n'existe que pour le flow YAML et le .feature, qui se modifient sans perte ; le code se modifie dans
 * la source. Chaque statut vient d'un service : vérification, enregistrement, Dry Run, exécution.
 * Des fonctions pures ; l'éditeur de code (CodeMirror) est monté par le contrôleur dans `data-cm-host`.
 */

export type EditorKind = 'flow' | 'feature' | 'code' | 'text';
export type EditorMode = 'visual' | 'source' | 'compare';
export type CompareSide = 'generated' | 'saved' | 'draft' | 'preview';

export type EditorOutline =
  | { kind: 'flow'; parse: FlowParse }
  | { kind: 'feature'; parse: GherkinParse }
  | { kind: 'code'; entries: CodeOutlineEntry[] }
  | { kind: 'text' };

export interface EditorBuffer {
  path: string;
  format: GenerationFormatName;
  /** Le contenu enregistré (sur le serveur) et le brouillon de l'écran. */
  saved: string;
  draft: string;
  revision?: string;
  editedAt?: string;
  status: string;
  validationMethod?: string;
  /** Les diagnostics de la dernière vérification, et le contenu qu'ils décrivent. */
  diagnostics: GeneratedFileDiagnostic[];
  checkedFor?: string;
  /** Le statut de la dernière vérification (celle du contenu `checkedFor`). */
  checkedStatus?: string;
  outline?: EditorOutline;
}

export interface EditorAddForm {
  path: string;
  after: number;
  scenario?: number;
  action: string;
  strategy: string;
  value: string;
  name: string;
  text: string;
  keyword: string;
}

export interface EditorUi {
  recording?: string;
  view?: GeneratedTestsView;
  open: string[];
  active?: string;
  buffers: Record<string, EditorBuffer>;
  mode: Record<string, EditorMode>;
  /** L'élément choisi : `<chemin>#<rang>` (flow) ou `<chemin>#<scénario>:<rang>` (.feature). */
  selected?: string;
  query: string;
  collapsed: string[];
  explorer: boolean;
  inspector: boolean;
  panel: 'diagnostics' | 'results';
  compare?: {
    path: string;
    left: CompareSide;
    right: CompareSide;
    texts: Partial<Record<CompareSide, string>>;
    loading?: boolean;
    summary?: { added: number; removed: number; changes: number };
  };
  /** Ce qu'une régénération écrirait (conflit avec des modifications à la main). */
  preview?: GenerationPreview;
  confirm?:
    | { kind: 'leave' }
    | { kind: 'close'; path: string }
    | { kind: 'restore'; path: string }
    | { kind: 'discard'; path: string }
    | { kind: 'remove'; path: string; index: number; scenario?: number };
  busy?: 'save' | 'check' | 'dry-run' | 'run' | 'restore';
  notice?: { tone: 'ok' | 'err' | 'info'; text: string; details?: string[] };
  adding?: EditorAddForm;
  kit: 'idle' | 'loading' | 'ready' | 'error';
  kitError?: string;
}

export const emptyEditorUi = (): EditorUi => ({
  open: [],
  buffers: {},
  mode: {},
  query: '',
  collapsed: [],
  explorer: true,
  inspector: true,
  panel: 'diagnostics',
  kit: 'idle',
});

// ── Les formats ──────────────────────────────────────────────────────────────────────────────

export function kindOf(path: string): EditorKind {
  if (path.endsWith('.flow.yaml')) return 'flow';
  if (path.endsWith('.feature')) return 'feature';
  if (/\.(ts|java)$/.test(path)) return 'code';
  return 'text';
}

export function languageOf(path: string): 'yaml' | 'gherkin' | 'typescript' | 'java' | 'xml' | 'text' {
  if (/\.ya?ml$/.test(path)) return 'yaml';
  if (path.endsWith('.feature')) return 'gherkin';
  if (path.endsWith('.ts')) return 'typescript';
  if (path.endsWith('.java')) return 'java';
  if (path.endsWith('.xml')) return 'xml';
  return 'text';
}

const FORMAT_ICON: Record<GenerationFormatName, string> = {
  yaml: 'YML',
  gherkin: 'FEAT',
  playwright: 'TS',
  java: 'JAVA',
};
const fileName = (path: string): string => path.split('/').pop() ?? path;

export const isDirty = (buffer: EditorBuffer | undefined): boolean =>
  buffer !== undefined && buffer.draft !== buffer.saved;
export const dirtyPaths = (ui: EditorUi): string[] =>
  Object.values(ui.buffers)
    .filter(isDirty)
    .map((buffer) => buffer.path);

/** Le mode affiché : la vue visuelle seulement là où elle existe (flow YAML, .feature lisibles). */
export function modeOf(ui: EditorUi, path: string): EditorMode {
  const mode = ui.mode[path];
  if (mode === 'compare') return mode;
  if (mode === 'visual' && visualAvailable(ui.buffers[path])) return 'visual';
  if (mode === undefined && visualAvailable(ui.buffers[path])) return 'visual';
  return 'source';
}

export function visualAvailable(buffer: EditorBuffer | undefined): boolean {
  const outline = buffer?.outline;
  return (outline?.kind === 'flow' || outline?.kind === 'feature') && outline.parse.ok;
}

/** Les diagnostics d'un fichier : ceux de la vérification, puis ceux de sa dernière exécution et de son Dry Run. */
export function diagnosticsOf(ui: EditorUi, path: string): GeneratedFileDiagnostic[] {
  const buffer = ui.buffers[path];
  if (!buffer) return [];
  const parseErrors =
    buffer.outline &&
    (buffer.outline.kind === 'flow' || buffer.outline.kind === 'feature') &&
    !buffer.outline.parse.ok
      ? buffer.outline.parse.diagnostics
      : [];
  const checked = buffer.checkedFor === buffer.draft ? buffer.diagnostics : [];
  return [
    ...parseErrors,
    ...checked.filter((entry) => !parseErrors.some((error) => error.message === entry.message)),
    ...runDiagnostics(ui, path),
  ];
}

const lastRun = (ui: EditorUi, path: string, mode: 'RUN' | 'DRY_RUN'): TestRunView | undefined => {
  const buffer = ui.buffers[path];
  if (!buffer) return undefined;
  return ui.view?.runs.find(
    (run) =>
      run.format === buffer.format &&
      (run.mode ?? 'RUN') === mode &&
      run.status !== 'QUEUED' &&
      run.status !== 'RUNNING',
  );
};

/**
 * Les échecs de la dernière exécution et du dernier Dry Run, rattachés à une ligne ou une étape quand
 * l'outil la donne (Dry Run : ligne ou étape ; Playwright, Java : `fichier:ligne` dans le message).
 */
export function runDiagnostics(ui: EditorUi, path: string): GeneratedFileDiagnostic[] {
  const out: GeneratedFileDiagnostic[] = [];
  const kind = kindOf(path);
  for (const mode of ['DRY_RUN', 'RUN'] as const) {
    const run = lastRun(ui, path, mode);
    if (!run) continue;
    if (mode === 'DRY_RUN' && kind !== 'flow' && kind !== 'feature') continue;
    for (const entry of run.cases) {
      if (entry.status === 'PASSED' || entry.status === 'MANUAL') continue;
      let line = entry.line;
      if (line === undefined && entry.message) {
        const located = new RegExp(`${fileName(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`).exec(
          entry.message,
        );
        if (located?.[1]) line = Number(located[1]);
      }
      if (line === undefined && entry.step === undefined && kind !== 'flow') continue;
      out.push({
        severity: entry.status === 'SKIPPED' ? 'warning' : 'error',
        category: 'execution',
        message: `${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}${entry.message ? ` : ${entry.message}` : ''}`,
        source: mode === 'DRY_RUN' ? 'Dry Run' : run.tool,
        ...(line !== undefined ? { line } : {}),
        ...(entry.step !== undefined ? { step: entry.step } : {}),
      });
    }
  }
  return out;
}

/** Le résultat d'une étape dans le dernier Dry Run (ou la dernière exécution) : pour la vue visuelle. */
function stepResult(
  ui: EditorUi,
  path: string,
  match: { step?: number; line?: number },
): { status: string; detail?: string } | undefined {
  for (const mode of ['DRY_RUN', 'RUN'] as const) {
    const run = lastRun(ui, path, mode);
    const found = run?.cases.find(
      (entry) =>
        (match.step !== undefined && entry.step === match.step) ||
        (match.line !== undefined && entry.line === match.line),
    );
    if (found) return { status: found.status, ...(found.detail ? { detail: found.detail } : {}) };
  }
  return undefined;
}

// ── Pièces ───────────────────────────────────────────────────────────────────────────────────

const iconButton = (action: string, label: string, name: string, attrs = ''): string =>
  `<button class="ed-ib" data-action="${action}" aria-label="${esc(label)}" title="${esc(label)}" ${attrs}>${icon(name)}</button>`;

const SEVERITY_ICON: Record<string, string> = { error: 'cross', warning: 'alert', info: 'info' };

function severityText(state: DashboardState, severity: string): string {
  return state.t.ed.severities[severity] ?? severity;
}

function saveChip(state: DashboardState, buffer: EditorBuffer): string {
  const t = state.t.ed;
  const ui = state.ed;
  if (ui.busy === 'save') return `<span class="ed-chip live" role="status">${esc(t.saving)}</span>`;
  if (isDirty(buffer))
    return `<span class="ed-chip warn"><i aria-hidden="true">●</i>${esc(t.unsaved)}</span>`;
  return `<span class="ed-chip ok">${icon('check')}${esc(t.saved)}</span>`;
}

function validationChip(
  state: DashboardState,
  buffer: EditorBuffer,
  diagnostics: readonly GeneratedFileDiagnostic[],
): string {
  const t = state.t.ed;
  if (state.ed.busy === 'check') return `<span class="ed-chip live" role="status">${esc(t.checking)}</span>`;
  const errors = diagnostics.filter(
    (entry) => entry.severity === 'error' && entry.category !== 'execution',
  ).length;
  if (errors > 0) return `<span class="ed-chip ko">${icon('cross')}${esc(t.errors(errors))}</span>`;
  if (buffer.checkedFor !== undefined && buffer.checkedFor !== buffer.draft)
    return `<span class="ed-chip mu">${esc(t.notCheckedSince)}</span>`;
  if (buffer.checkedFor === undefined && isDirty(buffer))
    return `<span class="ed-chip mu">${esc(t.notCheckedSince)}</span>`;
  const status =
    buffer.checkedFor === buffer.draft && buffer.checkedStatus ? buffer.checkedStatus : buffer.status;
  const label = state.t.tst.fileStatuses[status] ?? status;
  const tone = status === 'STATICALLY_VALIDATED' ? 'ok' : status === 'NOT_VALIDATED' ? 'warn' : 'mu';
  return `<span class="ed-chip ${tone}" title="${esc(t.staticOnly)}">${tone === 'ok' ? icon('check') : ''}${esc(label)}</span>`;
}

// ── Barre supérieure ──────────────────────────────────────────────────────────────────────────

function topBar(state: DashboardState, buffer: EditorBuffer | undefined): string {
  const t = state.t.ed;
  const ui = state.ed;
  const crumbs = `<nav class="ed-crumbs" aria-label="${esc(t.breadcrumb)}"><button class="lnk" data-action="ed-back">${esc(state.t.nav.tests)}</button><span aria-hidden="true">/</span><span>${esc(ui.recording ?? '')}</span>${
    buffer ? `<span aria-hidden="true">/</span><b>${esc(fileName(buffer.path))}</b>` : ''
  }</nav>`;
  if (!buffer) return `<header class="ed-top">${crumbs}</header>`;
  const diagnostics = diagnosticsOf(ui, buffer.path);
  const kind = kindOf(buffer.path);
  const runner = ui.view?.runners.find((entry) => entry.format === buffer.format);
  const engine = runner?.kind === 'ENGINE';
  const busy = ui.busy !== undefined;
  const decide = can(state, 'DECIDE') && (engine || can(state, 'RUN_WRITES'));
  const runAllowed = can(state, 'RUN') && (engine || can(state, 'RUN_WRITES')) && runner?.available === true;
  const dryRun = kind === 'flow' || kind === 'feature';
  const why = (reason: string | undefined): string => (reason ? `title="${esc(reason)}"` : '');
  const saveWhy = !decide ? t.noRight : !isDirty(buffer) ? t.nothingToSave : undefined;
  const runWhy = !runAllowed
    ? runner && !runner.available
      ? (runner.reason ?? t.unavailable)
      : t.noRight
    : isDirty(buffer)
      ? t.saveFirst
      : undefined;
  const dryWhy = !can(state, 'RUN') ? t.noRight : undefined;
  const actions = [
    `<button class="btn" data-action="ed-check" ${busy ? 'disabled' : ''} title="${esc(t.checkHint)}">${icon('check')}<span>${esc(t.check)}</span></button>`,
    dryRun
      ? `<button class="btn" data-action="ed-dry-run" ${busy || dryWhy ? 'disabled' : ''} ${why(dryWhy ?? t.dryRunHint)}>${icon('explorations')}<span>${esc(ui.busy === 'dry-run' ? t.dryRunning : t.dryRun)}</span></button>`
      : '',
    `<button class="btn" data-action="ed-run" ${busy || runWhy ? 'disabled' : ''} ${why(runWhy ?? t.runHint)}>${icon('play')}<span>${esc(ui.busy === 'run' ? t.running : t.run)}</span></button>`,
    `<button class="btn" data-action="ed-compare" aria-pressed="${modeOf(ui, buffer.path) === 'compare' ? 'true' : 'false'}">${icon('history')}<span>${esc(t.compare)}</span></button>`,
    `<button class="btn primary" data-action="ed-save" ${busy || saveWhy ? 'disabled' : ''} ${why(saveWhy ?? t.saveHint)}>${icon('download')}<span>${esc(t.save)}</span><kbd>Ctrl S</kbd></button>`,
  ].join('');
  return `<header class="ed-top">
<div class="ed-id">${crumbs}<div class="ed-meta"><span class="ed-fmt" title="${esc(state.t.tst.formats[buffer.format] ?? buffer.format)}">${esc(FORMAT_ICON[buffer.format])}</span>${saveChip(state, buffer)}${validationChip(state, buffer, diagnostics)}${
    buffer.editedAt
      ? `<span class="ed-chip warn" title="${esc(formatDate(buffer.editedAt, state.t.locale))}">${esc(state.t.tst.editedByHand)}</span>`
      : ''
  }</div></div>
<div class="ed-actions" role="toolbar" aria-label="${esc(t.actions)}">${actions}</div>
</header>`;
}

// ── Bandeaux (avis, confirmations) ────────────────────────────────────────────────────────────

function banners(state: DashboardState): string {
  const t = state.t.ed;
  const ui = state.ed;
  const notice = ui.notice
    ? `<div class="ed-note ${ui.notice.tone}" role="${ui.notice.tone === 'err' ? 'alert' : 'status'}"><p>${esc(ui.notice.text)}</p>${
        ui.notice.details && ui.notice.details.length > 0
          ? `<ul>${ui.notice.details.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>`
          : ''
      }<button class="ed-ib" data-action="ed-notice-close" aria-label="${esc(t.dismiss)}">${icon('close')}</button></div>`
    : '';
  const confirm = ui.confirm;
  if (!confirm) return notice;
  const box = (text: string, yes: string, yesAction: string, extra = ''): string =>
    `<div class="ed-confirm" role="alertdialog" aria-label="${esc(text)}"><p>${esc(text)}</p><div class="ed-row">${extra}<button class="btn danger" data-action="${yesAction}">${esc(yes)}</button><button class="btn" data-action="ed-confirm-cancel">${esc(t.stay)}</button></div></div>`;
  switch (confirm.kind) {
    case 'leave':
      return `${notice}${box(t.leaveText(dirtyPaths(ui).length), t.leaveWithout, 'ed-leave-confirm', `<button class="btn primary" data-action="ed-save-all">${esc(t.saveAll)}</button>`)}`;
    case 'close':
      return `${notice}${box(t.closeText(fileName(confirm.path)), t.closeWithout, 'ed-close-confirm')}`;
    case 'restore':
      return `${notice}${box(t.restoreText, state.t.tst.restore, 'ed-restore-confirm')}`;
    case 'discard':
      return `${notice}${box(t.discardText, t.discard, 'ed-discard-confirm')}`;
    case 'remove':
      return `${notice}${box(t.removeText(confirm.index + 1), t.remove, 'ed-remove-confirm')}`;
  }
}

// ── Explorateur ──────────────────────────────────────────────────────────────────────────────

function matches(query: string, text: string): boolean {
  return query === '' || text.toLowerCase().includes(query.toLowerCase());
}

function treeItem(options: {
  level: number;
  label: string;
  action: string;
  attrs: string;
  current?: boolean;
  expanded?: boolean;
  extra?: string;
  iconText?: string;
  focus?: boolean;
}): string {
  return `<li role="treeitem" aria-level="${String(options.level)}" ${options.expanded !== undefined ? `aria-expanded="${options.expanded ? 'true' : 'false'}"` : ''} ${options.current ? 'aria-current="true"' : ''} class="ed-ti${options.current ? ' cur' : ''}" style="--lv:${String(options.level)}"><button data-action="${options.action}" ${options.attrs} data-tree tabindex="${options.focus ? '0' : '-1'}">${options.iconText ? `<span class="ed-ft">${esc(options.iconText)}</span>` : ''}<span class="ed-tl">${esc(options.label)}</span>${options.extra ?? ''}</button></li>`;
}

function outlineItems(state: DashboardState, buffer: EditorBuffer): string[] {
  const ui = state.ed;
  const outline = buffer.outline;
  const q = ui.query;
  const items: string[] = [];
  const diagnostics = diagnosticsOf(ui, buffer.path);
  const flag = (has: boolean): string =>
    has
      ? `<span class="ed-flag ko" title="${esc(state.t.ed.hasProblem)}">${icon('alert')}<span class="sr">${esc(state.t.ed.hasProblem)}</span></span>`
      : '';
  if (outline?.kind === 'flow' && outline.parse.ok) {
    for (const step of outline.parse.outline.steps) {
      if (!matches(q, step.label)) continue;
      const key = `${buffer.path}#${String(step.index)}`;
      items.push(
        treeItem({
          level: 3,
          label: `${String(step.position)}. ${step.label}`,
          action: 'ed-select',
          attrs: `data-path="${esc(buffer.path)}" data-key="${String(step.index)}"`,
          current: ui.selected === key,
          extra: flag(
            diagnostics.some(
              (entry) =>
                entry.step === step.position ||
                (entry.line !== undefined && entry.line >= step.line && entry.line <= step.endLine),
            ),
          ),
        }),
      );
    }
  } else if (outline?.kind === 'feature' && outline.parse.ok) {
    outline.parse.outline.scenarios.forEach((scenario, scenarioIndex) => {
      items.push(
        treeItem({
          level: 3,
          label: `${scenario.keyword}: ${scenario.name}`,
          action: 'ed-goto',
          attrs: `data-path="${esc(buffer.path)}" data-line="${String(scenario.line)}"`,
        }),
      );
      for (const step of scenario.steps) {
        if (!matches(q, `${step.keyword}${step.text}`)) continue;
        const key = `${buffer.path}#${String(scenarioIndex)}:${String(step.index)}`;
        items.push(
          treeItem({
            level: 4,
            label: `${step.keyword}${step.text}`,
            action: 'ed-select',
            attrs: `data-path="${esc(buffer.path)}" data-key="${String(scenarioIndex)}:${String(step.index)}"`,
            current: ui.selected === key,
            extra: flag(
              diagnostics.some(
                (entry) => entry.line !== undefined && entry.line >= step.line && entry.line <= step.endLine,
              ),
            ),
          }),
        );
      }
    });
  } else if (outline?.kind === 'code') {
    for (const entry of outline.entries) {
      if (!matches(q, entry.label)) continue;
      items.push(
        treeItem({
          level: entry.kind === 'step' ? 4 : 3,
          label: `${entry.label}${entry.actions ? ` · ${state.t.ed.actionsCount(entry.actions)}` : ''}`,
          action: 'ed-goto',
          attrs: `data-path="${esc(buffer.path)}" data-line="${String(entry.line)}"`,
        }),
      );
    }
  }
  return items;
}

function explorer(state: DashboardState): string {
  const t = state.t.ed;
  const ui = state.ed;
  const files = ui.view?.files ?? [];
  const formats = [...new Set(files.map((file) => file.format))];
  const rows: string[] = [];
  for (const format of formats) {
    const collapsed = ui.collapsed.includes(`format:${format}`);
    const list = files.filter((file) => file.format === format);
    const visible = list.filter((file) => matches(ui.query, file.path) || ui.query !== '');
    rows.push(
      treeItem({
        level: 1,
        label: `${state.t.tst.formats[format] ?? format} (${String(list.length)})`,
        action: 'ed-collapse',
        attrs: `data-key="format:${format}"`,
        expanded: !collapsed,
      }),
    );
    if (collapsed) continue;
    for (const file of visible) {
      const buffer = ui.buffers[file.path];
      const fileMatch = matches(ui.query, file.path);
      const outline = buffer && file.path === ui.active ? outlineItems(state, buffer) : [];
      if (!fileMatch && outline.length === 0) continue;
      const errors = buffer
        ? diagnosticsOf(ui, file.path).filter((entry) => entry.severity === 'error').length
        : 0;
      rows.push(
        treeItem({
          level: 2,
          label: fileName(file.path),
          action: 'ed-open',
          attrs: `data-path="${esc(file.path)}" title="${esc(file.path)}"`,
          current: file.path === ui.active,
          focus: file.path === ui.active,
          iconText: FORMAT_ICON[file.format],
          extra: `${isDirty(buffer) ? `<span class="ed-flag warn" title="${esc(t.unsaved)}">●<span class="sr">${esc(t.unsaved)}</span></span>` : ''}${
            file.editedAt
              ? `<span class="ed-flag" title="${esc(state.t.tst.editedByHand)}">M<span class="sr">${esc(state.t.tst.editedByHand)}</span></span>`
              : ''
          }${errors > 0 ? `<span class="ed-flag ko" title="${esc(t.errors(errors))}">${icon('cross')}<span class="sr">${esc(t.errors(errors))}</span></span>` : ''}`,
        }),
      );
      rows.push(...outline);
    }
  }
  return `<aside class="ed-explorer" aria-label="${esc(t.explorer)}">
<div class="ed-ph"><h2>${esc(t.explorer)}</h2>${iconButton('ed-toggle-explorer', t.hideExplorer, 'close')}</div>
<label class="ed-search"><span class="sr">${esc(t.search)}</span>${icon('search')}<input type="search" data-ed="query" value="${esc(ui.query)}" placeholder="${esc(t.searchPlaceholder)}" autocomplete="off"></label>
<ul class="ed-tree" role="tree" aria-label="${esc(t.files)}">${rows.join('') || `<li class="mu ed-empty">${esc(t.noMatch)}</li>`}</ul>
</aside>`;
}

// ── Onglets et barre de vue ────────────────────────────────────────────────────────────────────

function tabs(state: DashboardState): string {
  const t = state.t.ed;
  const ui = state.ed;
  return `<div class="ed-tabs" role="tablist" aria-label="${esc(t.openFiles)}">${ui.open
    .map((path) => {
      const buffer = ui.buffers[path];
      const active = path === ui.active;
      return `<div class="ed-tab${active ? ' on' : ''}" role="presentation"><button role="tab" aria-selected="${active ? 'true' : 'false'}" data-action="ed-tab" data-path="${esc(path)}" title="${esc(path)}"><span class="ed-ft">${esc(buffer ? FORMAT_ICON[buffer.format] : '')}</span>${esc(fileName(path))}${isDirty(buffer) ? `<i class="ed-dot" aria-label="${esc(t.unsaved)}">●</i>` : ''}</button>${iconButton('ed-close', t.closeTab(fileName(path)), 'close', `data-path="${esc(path)}"`)}</div>`;
    })
    .join('')}</div>`;
}

function viewBar(state: DashboardState, buffer: EditorBuffer): string {
  const t = state.t.ed;
  const ui = state.ed;
  const mode = modeOf(ui, buffer.path);
  const visual = visualAvailable(buffer);
  const kind = kindOf(buffer.path);
  const segment = (value: EditorMode, label: string, enabled: boolean, why?: string): string =>
    `<button role="radio" aria-checked="${mode === value ? 'true' : 'false'}" data-action="ed-mode" data-mode="${value}" ${enabled ? '' : 'disabled'} ${why ? `title="${esc(why)}"` : ''}>${esc(label)}</button>`;
  const visualWhy =
    kind === 'code' ? t.visualCode : kind === 'text' ? t.visualText : !visual ? t.visualBroken : undefined;
  return `<div class="ed-viewbar"><div class="ed-seg" role="radiogroup" aria-label="${esc(t.viewLabel)}">${segment('visual', t.visual, visual, visualWhy)}${segment('source', t.source, true)}${segment('compare', t.compare, true)}</div><span class="ed-hint">${esc(visualWhy && mode !== 'compare' ? visualWhy : t.shortcuts)}</span>${
    !ui.explorer ? iconButton('ed-toggle-explorer', t.showExplorer, 'menu') : ''
  }${!ui.inspector ? `<button class="lnk" data-action="ed-toggle-inspector">${esc(t.showInspector)}</button>` : ''}</div>`;
}

// ── Vue visuelle : flow YAML ──────────────────────────────────────────────────────────────────

const RESULT_TONE: Record<string, string> = { PASSED: 'ok', FAILED: 'ko', BLOCKED: 'warn', SKIPPED: 'mu' };

function stepRow(
  state: DashboardState,
  buffer: EditorBuffer,
  step: FlowStepNode,
  count: number,
  diagnostics: readonly GeneratedFileDiagnostic[],
): string {
  const t = state.t.ed;
  const ui = state.ed;
  const selected = ui.selected === `${buffer.path}#${String(step.index)}`;
  const problems = diagnostics.filter(
    (entry) =>
      entry.category !== 'execution' &&
      (entry.step === step.position ||
        (entry.line !== undefined && entry.line >= step.line && entry.line <= step.endLine)),
  );
  const result = stepResult(ui, buffer.path, { step: step.position });
  const status = problems.some((entry) => entry.severity === 'error')
    ? `<span class="ed-st ko">${icon('cross')}${esc(t.invalid)}</span>`
    : result
      ? `<span class="ed-st ${RESULT_TONE[result.status] ?? 'mu'}" title="${esc(result.detail ?? '')}">${esc(state.t.tst.caseStatuses[result.status] ?? result.status)}</span>`
      : '';
  const edit = can(state, 'DECIDE');
  const tools = edit
    ? `<span class="ed-tools">${iconButton('ed-move', t.moveUp, 'up', `data-index="${String(step.index)}" data-to="${String(step.index - 1)}" ${step.index === 0 ? 'disabled' : ''}`)}${iconButton('ed-move', t.moveDown, 'down', `data-index="${String(step.index)}" data-to="${String(step.index + 1)}" ${step.index === count - 1 ? 'disabled' : ''}`)}${iconButton('ed-duplicate', t.duplicate, 'copy', `data-index="${String(step.index)}"`)}${iconButton('ed-remove', t.remove, 'trash', `data-index="${String(step.index)}"`)}</span>`
    : '';
  return `<li class="ed-step${selected ? ' sel' : ''}" data-index="${String(step.index)}" ${edit ? 'draggable="true"' : ''}>
${edit ? `<span class="ed-grip" aria-hidden="true">${icon('grip')}</span>` : ''}<button class="ed-sm" data-action="ed-select" data-path="${esc(buffer.path)}" data-key="${String(step.index)}" aria-pressed="${selected ? 'true' : 'false'}"><span class="ed-num">${String(step.position)}</span><span class="ed-act">${esc(step.action)}</span><span class="ed-lab">${esc(step.label)}</span>${
    step.testData.length > 0
      ? `<span class="ed-dep" title="${esc(t.usesData(step.testData.join(', ')))}">${icon('data')}<span class="sr">${esc(t.usesData(step.testData.join(', ')))}</span></span>`
      : ''
  }${step.allow.length > 0 ? `<span class="ed-dep" title="${esc(t.allows(step.allow.join(', ')))}">${icon('access')}<span class="sr">${esc(t.allows(step.allow.join(', ')))}</span></span>` : ''}${status}</button>${tools}
</li>`;
}

function addStepForm(state: DashboardState, buffer: EditorBuffer, groupLabel: string): string {
  const t = state.t.ed;
  const form = state.ed.adding;
  if (!form || form.path !== buffer.path) return '';
  const kind = kindOf(buffer.path);
  if (kind === 'feature') {
    const outline =
      buffer.outline?.kind === 'feature' && buffer.outline.parse.ok
        ? buffer.outline.parse.outline
        : undefined;
    const keywords = outline
      ? [
          ...outline.keywords.given,
          ...outline.keywords.when,
          ...outline.keywords.then,
          ...outline.keywords.and,
          ...outline.keywords.but,
        ]
      : [];
    return `<form class="ed-add" data-action="ed-add-submit" aria-label="${esc(t.addStep)}"><h4>${esc(t.addAfter(form.after + 1))}</h4><div class="ed-fields"><label>${esc(t.keyword)}<select data-ed-add="keyword">${keywords.map((keyword) => `<option value="${esc(keyword)}" ${keyword === form.keyword ? 'selected' : ''}>${esc(keyword.trim())}</option>`).join('')}</select></label><label class="wide">${esc(t.sentence)}<input data-ed-add="text" value="${esc(form.text)}" required></label></div><div class="ed-row"><button class="btn primary" type="submit">${esc(t.add)}</button><button class="btn" type="button" data-action="ed-add-cancel">${esc(t.cancel)}</button></div></form>`;
  }
  const actions = ['click', 'fill', 'select', 'check', 'uncheck', 'expect', 'goto', 'manual'];
  const targeted = ['click', 'fill', 'select', 'check', 'uncheck'].includes(form.action);
  const fields = [
    `<label>${esc(t.action)}<select data-ed-add="action">${actions.map((action) => `<option value="${action}" ${action === form.action ? 'selected' : ''}>${esc(t.actions_[action] ?? action)}</option>`).join('')}</select></label>`,
    targeted
      ? `<label>${esc(t.strategy)}<select data-ed-add="strategy">${['role', 'label', 'text', 'testId', 'css'].map((strategy) => `<option value="${strategy}" ${strategy === form.strategy ? 'selected' : ''}>${esc(t.strategies[strategy] ?? strategy)}</option>`).join('')}</select></label><label>${esc(t.targetValue)}<input data-ed-add="value" value="${esc(form.value)}" required></label>${form.strategy === 'role' ? `<label>${esc(t.accessibleName)}<input data-ed-add="name" value="${esc(form.name)}"></label>` : ''}`
      : '',
    form.action === 'fill' ||
    form.action === 'select' ||
    form.action === 'expect' ||
    form.action === 'goto' ||
    form.action === 'manual'
      ? `<label class="wide">${esc(form.action === 'goto' ? t.url : form.action === 'select' ? t.option : form.action === 'expect' ? t.expectText : form.action === 'manual' ? t.manualText : t.value)}<input data-ed-add="text" value="${esc(form.text)}" required></label>`
      : '',
  ].join('');
  return `<form class="ed-add" data-action="ed-add-submit" aria-label="${esc(t.addStep)}"><h4>${esc(t.addAfter(form.after + 1))}${groupLabel ? ` · ${esc(groupLabel)}` : ''}</h4><div class="ed-fields">${fields}</div><div class="ed-row"><button class="btn primary" type="submit">${esc(t.add)}</button><button class="btn" type="button" data-action="ed-add-cancel">${esc(t.cancel)}</button></div></form>`;
}

function flowVisual(state: DashboardState, buffer: EditorBuffer): string {
  const t = state.t.ed;
  const ui = state.ed;
  const parse = buffer.outline?.kind === 'flow' ? buffer.outline.parse : undefined;
  if (!parse?.ok) return '';
  const { steps, groups, name, startAt } = parse.outline;
  const diagnostics = diagnosticsOf(ui, buffer.path);
  const edit = can(state, 'DECIDE');
  const section = (group: FlowGroupNode | undefined, list: FlowStepNode[]): string => {
    const key = `group:${group?.id ?? '-'}`;
    const collapsed = ui.collapsed.includes(key);
    const last = list[list.length - 1];
    return `<section class="ed-group"><header><button class="ed-gh" data-action="ed-collapse" data-key="${esc(key)}" aria-expanded="${collapsed ? 'false' : 'true'}">${icon(collapsed ? 'right' : 'down')}<b>${esc(group?.name ?? t.noGroup)}</b><span class="mu">${esc(t.stepsCount(list.length))}</span></button>${
      edit && last
        ? `<button class="lnk" data-action="ed-add" data-after="${String(last.index)}">${icon('plus')}${esc(t.addStep)}</button>`
        : ''
    }</header>${group?.description ? `<p class="mu ed-gd">${esc(group.description)}</p>` : ''}${
      collapsed
        ? ''
        : `<ol class="ed-steps" data-path="${esc(buffer.path)}">${list.map((step) => stepRow(state, buffer, step, steps.length, diagnostics)).join('')}</ol>`
    }${ui.adding?.path === buffer.path && list.some((step) => step.index === ui.adding?.after) ? addStepForm(state, buffer, group?.name ?? '') : ''}</section>`;
  };
  const grouped = groups.map((group) =>
    section(
      group,
      steps.filter((step) => step.group === group.id),
    ),
  );
  const loose = steps.filter((step) => step.group === undefined);
  // Les groupes dans l'ordre de leur première étape, les étapes sans groupe à leur place.
  const blocks: { at: number; html: string }[] = [
    ...groups.map((group, index) => ({ at: Math.min(...group.steps), html: grouped[index] ?? '' })),
    ...(loose.length > 0 ? [{ at: loose[0]?.position ?? 0, html: section(undefined, loose) }] : []),
  ].sort((a, b) => a.at - b.at);
  return `<div class="ed-visual"><div class="ed-vh"><h3>${esc(name ?? '')}</h3>${startAt ? `<span class="mu">${esc(t.startAt(startAt))}</span>` : ''}<span class="mu">${esc(t.stepsCount(steps.length))}</span></div>${blocks.map((block) => block.html).join('')}<p class="mu ed-help">${esc(edit ? t.visualHelp : t.readOnlyHelp)}</p></div>`;
}

// ── Vue visuelle : .feature ───────────────────────────────────────────────────────────────────

function featureVisual(state: DashboardState, buffer: EditorBuffer): string {
  const t = state.t.ed;
  const ui = state.ed;
  const parse = buffer.outline?.kind === 'feature' ? buffer.outline.parse : undefined;
  if (!parse?.ok) return '';
  const diagnostics = diagnosticsOf(ui, buffer.path);
  const edit = can(state, 'DECIDE');
  const scenarios = parse.outline.scenarios
    .map((scenario, scenarioIndex) => {
      const rows = scenario.steps
        .map((step: GherkinStepNode) => {
          const key = `${String(scenarioIndex)}:${String(step.index)}`;
          const selected = ui.selected === `${buffer.path}#${key}`;
          const problems = diagnostics.filter(
            (entry) =>
              entry.category !== 'execution' &&
              entry.line !== undefined &&
              entry.line >= step.line &&
              entry.line <= step.endLine,
          );
          const result = stepResult(ui, buffer.path, { line: step.line });
          const status = problems.some((entry) => entry.severity === 'error')
            ? `<span class="ed-st ko">${icon('cross')}${esc(problems[0]?.category === 'references' ? t.unknownSentence : t.invalid)}</span>`
            : result
              ? `<span class="ed-st ${RESULT_TONE[result.status] ?? 'mu'}" title="${esc(result.detail ?? '')}">${esc(state.t.tst.caseStatuses[result.status] ?? result.status)}</span>`
              : '';
          const tools = edit
            ? `<span class="ed-tools">${iconButton('ed-move', t.moveUp, 'up', `data-scenario="${String(scenarioIndex)}" data-index="${String(step.index)}" data-to="${String(step.index - 1)}" ${step.index === 0 ? 'disabled' : ''}`)}${iconButton('ed-move', t.moveDown, 'down', `data-scenario="${String(scenarioIndex)}" data-index="${String(step.index)}" data-to="${String(step.index + 1)}" ${step.index === scenario.steps.length - 1 ? 'disabled' : ''}`)}${iconButton('ed-duplicate', t.duplicate, 'copy', `data-scenario="${String(scenarioIndex)}" data-index="${String(step.index)}"`)}${iconButton('ed-remove', t.remove, 'trash', `data-scenario="${String(scenarioIndex)}" data-index="${String(step.index)}"`)}</span>`
            : '';
          return `<li class="ed-step${selected ? ' sel' : ''}" data-scenario="${String(scenarioIndex)}" data-index="${String(step.index)}" ${edit ? 'draggable="true"' : ''}>${edit ? `<span class="ed-grip" aria-hidden="true">${icon('grip')}</span>` : ''}<button class="ed-sm" data-action="ed-select" data-path="${esc(buffer.path)}" data-key="${key}" aria-pressed="${selected ? 'true' : 'false'}"><span class="ed-num">${String(step.line)}</span><span class="ed-kw">${esc(step.keyword.trim())}</span><span class="ed-lab">${esc(step.text)}</span>${step.argument ? `<span class="ed-dep" title="${esc(step.argument === 'table' ? t.withTable : t.withDocString)}">${icon('data')}</span>` : ''}${status}</button>${tools}</li>`;
        })
        .join('');
      const last = scenario.steps[scenario.steps.length - 1];
      return `<section class="ed-group"><header><span class="ed-gh"><b>${esc(scenario.keyword)} : ${esc(scenario.name)}</b>${scenario.tags.length > 0 ? `<span class="mu">${esc(scenario.tags.join(' '))}</span>` : ''}${scenario.examples > 0 ? `<span class="mu">${esc(t.examples(scenario.examples))}</span>` : ''}</span>${
        edit && last
          ? `<button class="lnk" data-action="ed-add" data-scenario="${String(scenarioIndex)}" data-after="${String(last.index)}">${icon('plus')}${esc(t.addStep)}</button>`
          : ''
      }</header><ol class="ed-steps" data-path="${esc(buffer.path)}" data-scenario="${String(scenarioIndex)}">${rows}</ol>${ui.adding?.path === buffer.path && ui.adding.scenario === scenarioIndex ? addStepForm(state, buffer, '') : ''}</section>`;
    })
    .join('');
  const feature = parse.outline.feature;
  return `<div class="ed-visual"><div class="ed-vh"><h3>${esc(feature ? `${feature.keyword} : ${feature.name}` : '')}</h3><span class="mu">${esc(t.language(parse.outline.language))}</span></div>${scenarios}<p class="mu ed-help">${esc(edit ? t.visualHelp : t.readOnlyHelp)}</p></div>`;
}

// ── Comparaison ──────────────────────────────────────────────────────────────────────────────

function compareStage(state: DashboardState, buffer: EditorBuffer): string {
  const t = state.t.ed;
  const ui = state.ed;
  const compare = ui.compare?.path === buffer.path ? ui.compare : undefined;
  const sides: CompareSide[] = [
    'generated',
    'saved',
    'draft',
    ...(ui.preview?.files.some((file) => file.path === buffer.path) ? (['preview'] as const) : []),
  ];
  const pick = (which: 'left' | 'right', value: CompareSide | undefined): string =>
    `<label>${esc(which === 'left' ? t.left : t.right)}<select data-ed="compare-${which}">${sides.map((side) => `<option value="${side}" ${side === value ? 'selected' : ''}>${esc(t.sides[side])}</option>`).join('')}</select></label>`;
  const summary = compare?.summary
    ? compare.summary.changes === 0
      ? `<span class="ed-chip ok">${esc(t.identical)}</span>`
      : `<span class="ed-chip add">+${String(compare.summary.added)}</span><span class="ed-chip del">−${String(compare.summary.removed)}</span><span class="mu">${esc(t.changes(compare.summary.changes))}</span>`
    : '';
  const edit = can(state, 'DECIDE');
  const actions = [
    buffer.editedAt && edit
      ? `<button class="btn" data-action="ed-restore">${icon('undo')}<span>${esc(state.t.tst.restore)}</span></button>`
      : '',
    isDirty(buffer) ? `<button class="btn" data-action="ed-discard">${esc(t.discard)}</button>` : '',
    ui.preview?.files.some((file) => file.path === buffer.path) && edit
      ? `<button class="btn danger" data-action="ed-overwrite">${esc(state.t.tst.overwrite)}</button>`
      : '',
  ].join('');
  return `<div class="ed-compare"><div class="ed-ch">${pick('left', compare?.left)}<span aria-hidden="true">→</span>${pick('right', compare?.right)}<div class="ed-sum" role="status">${compare?.loading ? esc(t.loading) : summary}</div><div class="ed-row">${actions}</div></div><div class="ed-diff" data-diff-host aria-label="${esc(t.diffLabel)}"></div></div>`;
}

// ── Inspecteur ───────────────────────────────────────────────────────────────────────────────

const field = (label: string, control: string, hint = ''): string =>
  `<label class="ed-f"><span>${esc(label)}</span>${control}${hint ? `<small class="mu">${esc(hint)}</small>` : ''}</label>`;

function selectedFlowStep(state: DashboardState, buffer: EditorBuffer): FlowStepNode | undefined {
  const key = state.ed.selected;
  if (!key?.startsWith(`${buffer.path}#`) || buffer.outline?.kind !== 'flow' || !buffer.outline.parse.ok)
    return undefined;
  const index = Number(key.slice(buffer.path.length + 1));
  return buffer.outline.parse.outline.steps[index];
}

function flowInspector(state: DashboardState, buffer: EditorBuffer, step: FlowStepNode): string {
  const t = state.t.ed;
  const parse =
    buffer.outline?.kind === 'flow' && buffer.outline.parse.ok ? buffer.outline.parse.outline : undefined;
  const ro = can(state, 'DECIDE') ? '' : 'disabled';
  const at = `data-index="${String(step.index)}"`;
  const input = (name: string, value: string | number | undefined, type = 'text', extra = ''): string =>
    `<input type="${type}" data-ed-field="${name}" ${at} value="${esc(value === undefined ? '' : String(value))}" ${ro} ${extra}>`;
  const sections: string[] = [];
  const diag = diagnosticsOf(state.ed, buffer.path).filter(
    (entry) =>
      entry.step === step.position ||
      (entry.line !== undefined && entry.line >= step.line && entry.line <= step.endLine),
  );
  sections.push(
    `<details open><summary>${esc(t.sec.action)}</summary>${field(t.action, `<output>${esc(t.actions_[step.action] ?? step.action)}</output>`)}${field(t.stepName, input('name', step.name, 'text', `placeholder="${esc(step.label)}"`), t.stepNameHint)}${
      step.intent
        ? field(
            t.intent,
            `<output>${esc(step.intent.name)}${step.intent.status ? ` · ${esc(step.intent.status)}` : ''}${step.intent.confidence !== undefined ? ` · ${String(Math.round(step.intent.confidence * 100))} %` : ''}</output>`,
          )
        : ''
    }</details>`,
  );
  if (step.target) {
    const strategies = ['role', 'label', 'text', 'testId', 'css'];
    sections.push(
      `<details open><summary>${esc(t.sec.target)}</summary>${field(t.strategy, `<select data-ed-field="strategy" ${at} ${ro}>${strategies.map((strategy) => `<option value="${strategy}" ${strategy === step.target?.strategy ? 'selected' : ''}>${esc(t.strategies[strategy] ?? strategy)}</option>`).join('')}</select>`)}${field(t.targetValue, input('targetValue', step.target.value))}${
        step.target.strategy === 'role' ? field(t.accessibleName, input('targetName', step.target.name)) : ''
      }<div class="ed-inline">${field(t.exact, `<input type="checkbox" data-ed-field="exact" ${at} ${step.target.exact ? 'checked' : ''} ${ro}>`)}${field(t.nth, input('nth', step.target.nth, 'number', 'min="0" step="1"'))}</div>${
        step.target.extra.length > 0
          ? `<p class="mu">${esc(t.keptKeys(step.target.extra.join(', ')))}</p>`
          : ''
      }</details>`,
    );
  }
  const params: string[] = [];
  if (step.action === 'fill' && step.value)
    params.push(
      field(
        t.valueKind,
        `<select data-ed-field="valueKind" ${at} ${ro}>${(['literal', 'testData', 'env'] as const).map((kind) => `<option value="${kind}" ${kind === step.value?.kind ? 'selected' : ''}>${esc(t.valueKinds[kind])}</option>`).join('')}</select>`,
      ),
      field(
        step.value.kind === 'testData' ? t.dataKey : step.value.kind === 'env' ? t.envName : t.value,
        input('valueText', step.value.text),
        step.value.kind === 'env' ? t.envHint : '',
      ),
    );
  if (step.action === 'select') params.push(field(t.option, input('option', step.option)));
  if (step.action === 'goto') params.push(field(t.url, input('url', step.url)));
  if (step.action === 'manual' || step.action === 'screenshot' || step.action === 'auto')
    params.push(field(t.manualText, input('text', step.text)));
  if (step.action === 'expect')
    params.push(
      field(t.expectText, input('expectText', step.expect?.text)),
      field(t.expectUrl, input('expectUrl', step.expect?.url)),
    );
  params.push(
    `<fieldset class="ed-allow"><legend>${esc(t.allow)}</legend>${['MUTATION', 'UNKNOWN', 'DANGEROUS'].map((entry) => `<label><input type="checkbox" data-ed-field="allow" data-value="${entry}" ${at} ${step.allow.includes(entry) ? 'checked' : ''} ${ro}>${esc(entry)}</label>`).join('')}<small class="mu">${esc(t.allowHint)}</small></fieldset>`,
    `<div class="ed-inline">${field(t.optional, `<input type="checkbox" data-ed-field="optional" ${at} ${step.optional ? 'checked' : ''} ${ro}>`)}${field(t.timeout, input('timeoutMs', step.timeoutMs, 'number', 'min="1" step="100"'))}</div>`,
  );
  sections.push(`<details open><summary>${esc(t.sec.params)}</summary>${params.join('')}</details>`);
  if (step.testData.length > 0 || parse?.testDataFile)
    sections.push(
      `<details open><summary>${esc(t.sec.data)}</summary>${step.testData.length > 0 ? `<ul class="ed-keys">${step.testData.map((key) => `<li><code>${esc(key)}</code></li>`).join('')}</ul>` : `<p class="mu">${esc(t.noData)}</p>`}${parse?.testDataFile ? `<p class="mu">${esc(t.dataFile(parse.testDataFile))}</p>` : ''}</details>`,
    );
  const assertions = parse?.assertions.filter((assertion) => assertion.after === step.position) ?? [];
  if (assertions.length > 0)
    sections.push(
      `<details open><summary>${esc(t.sec.assertions)}</summary><ul class="ed-keys">${assertions.map((assertion) => `<li><b>${esc(assertion.id)}</b>${assertion.description ? ` — ${esc(assertion.description)}` : ''}</li>`).join('')}</ul></details>`,
    );
  if (parse && parse.groups.length > 0)
    sections.push(
      `<details open><summary>${esc(t.sec.dependencies)}</summary>${field(t.group, `<select data-ed-field="group" ${at} ${ro}><option value="">${esc(t.noGroup)}</option>${parse.groups.map((group) => `<option value="${esc(group.id)}" ${group.id === step.group ? 'selected' : ''}>${esc(group.name)}</option>`).join('')}</select>`, t.groupHint)}</details>`,
    );
  if (diag.length > 0)
    sections.push(
      `<details open><summary>${esc(t.sec.diagnostics)} (${String(diag.length)})</summary>${diagnosticList(state, diag, buffer.path)}</details>`,
    );
  sections.push(
    `<details><summary>${esc(t.sec.meta)}</summary><dl class="ed-dl"><dt>${esc(t.lines)}</dt><dd><button class="lnk" data-action="ed-goto" data-path="${esc(buffer.path)}" data-line="${String(step.line)}">${esc(t.lineRange(step.line, step.endLine))}</button></dd>${
      step.provenance
        ? `<dt>${esc(t.provenance)}</dt><dd><code class="ed-wrap">${esc(step.provenance)}</code></dd>`
        : ''
    }<dt>${esc(t.effects)}</dt><dd>${esc(step.hasEffects ? t.present : t.absent)}</dd><dt>${esc(t.fingerprint)}</dt><dd>${esc(step.hasFingerprint ? t.present : t.absent)}</dd></dl><p class="mu">${esc(t.metaHint)}</p></details>`,
  );
  return `<div class="ed-ih"><h3>${esc(t.stepTitle(step.position))}</h3><p class="mu">${esc(step.label)}</p></div>${sections.join('')}`;
}

function featureInspector(
  state: DashboardState,
  buffer: EditorBuffer,
  scenarioIndex: number,
  index: number,
): string {
  const t = state.t.ed;
  const parse =
    buffer.outline?.kind === 'feature' && buffer.outline.parse.ok ? buffer.outline.parse.outline : undefined;
  const step = parse?.scenarios[scenarioIndex]?.steps[index];
  if (!parse || !step) return '';
  const ro = can(state, 'DECIDE') ? '' : 'disabled';
  const at = `data-scenario="${String(scenarioIndex)}" data-index="${String(index)}"`;
  const keywords = [
    ...parse.keywords.given,
    ...parse.keywords.when,
    ...parse.keywords.then,
    ...parse.keywords.and,
    ...parse.keywords.but,
  ];
  const diag = diagnosticsOf(state.ed, buffer.path).filter(
    (entry) => entry.line !== undefined && entry.line >= step.line && entry.line <= step.endLine,
  );
  return `<div class="ed-ih"><h3>${esc(t.stepTitle(index + 1))}</h3><p class="mu">${esc(parse.scenarios[scenarioIndex]?.name ?? '')}</p></div>
<details open><summary>${esc(t.sec.action)}</summary>${field(t.keyword, `<select data-ed-field="keyword" ${at} ${ro}>${[...new Set([step.keyword, ...keywords])].map((keyword) => `<option value="${esc(keyword)}" ${keyword === step.keyword ? 'selected' : ''}>${esc(keyword.trim())}</option>`).join('')}</select>`)}${field(t.sentence, `<input type="text" data-ed-field="sentence" ${at} value="${esc(step.text)}" ${ro}>`, t.sentenceHint)}${
    step.argument ? `<p class="mu">${esc(step.argument === 'table' ? t.withTable : t.withDocString)}</p>` : ''
  }</details>
${diag.length > 0 ? `<details open><summary>${esc(t.sec.diagnostics)} (${String(diag.length)})</summary>${diagnosticList(state, diag, buffer.path)}</details>` : ''}
<details><summary>${esc(t.sec.meta)}</summary><dl class="ed-dl"><dt>${esc(t.lines)}</dt><dd><button class="lnk" data-action="ed-goto" data-path="${esc(buffer.path)}" data-line="${String(step.line)}">${esc(t.lineRange(step.line, step.endLine))}</button></dd>${step.provenance ? `<dt>${esc(t.provenance)}</dt><dd><code class="ed-wrap">${esc(step.provenance)}</code></dd>` : ''}<dt>${esc(t.keywordType)}</dt><dd>${esc(step.keywordType)}</dd></dl></details>`;
}

function inspector(state: DashboardState, buffer: EditorBuffer | undefined): string {
  const t = state.t.ed;
  const ui = state.ed;
  let body = `<p class="mu ed-empty">${esc(t.selectHint)}</p>`;
  if (buffer) {
    const kind = kindOf(buffer.path);
    const key = ui.selected?.startsWith(`${buffer.path}#`)
      ? ui.selected.slice(buffer.path.length + 1)
      : undefined;
    if (kind === 'flow') {
      const step = selectedFlowStep(state, buffer);
      if (step) body = flowInspector(state, buffer, step);
    } else if (kind === 'feature' && key?.includes(':')) {
      const [scenario, index] = key.split(':').map(Number);
      body = featureInspector(state, buffer, scenario ?? 0, index ?? 0) || body;
    } else if (kind === 'code' || kind === 'text')
      body = `<p class="mu ed-empty">${esc(kind === 'code' ? t.codeInspector : t.textInspector)}</p>`;
    if (!visualAvailable(buffer) && (kind === 'flow' || kind === 'feature'))
      body = `<p class="mu ed-empty">${esc(t.visualBroken)}</p>`;
  }
  return `<aside class="ed-inspector" aria-label="${esc(t.inspector)}"><div class="ed-ph"><h2>${esc(t.inspector)}</h2>${iconButton('ed-toggle-inspector', t.hideInspector, 'close')}</div><div class="ed-ib-body">${body}</div></aside>`;
}

// ── Diagnostics et résultats ───────────────────────────────────────────────────────────────────

function diagnosticList(
  state: DashboardState,
  list: readonly GeneratedFileDiagnostic[],
  path: string,
): string {
  const t = state.t.ed;
  return `<ul class="ed-dlist">${list
    .map((entry) => {
      const where = [
        entry.file ? fileName(entry.file) : '',
        entry.line !== undefined ? t.line(entry.line) : '',
        entry.step !== undefined ? t.step(entry.step) : '',
      ]
        .filter(Boolean)
        .join(' · ');
      const target = entry.file ?? path;
      return `<li class="${entry.severity}"><button data-action="ed-diag" data-path="${esc(target)}" ${entry.line !== undefined ? `data-line="${String(entry.line)}"` : ''} ${entry.column !== undefined ? `data-column="${String(entry.column)}"` : ''} ${entry.step !== undefined ? `data-step="${String(entry.step)}"` : ''}><span class="ed-sev">${icon(SEVERITY_ICON[entry.severity] ?? 'info')}<span>${esc(severityText(state, entry.severity))}</span></span><span class="ed-msg">${esc(entry.message)}</span><span class="ed-where">${esc(where)}${where ? ' · ' : ''}${esc(entry.source)}</span></button></li>`;
    })
    .join('')}</ul>`;
}

function diagnosticsPanel(state: DashboardState, buffer: EditorBuffer): string {
  const t = state.t.ed;
  const list = diagnosticsOf(state.ed, buffer.path);
  if (list.length === 0) {
    const atGeneration =
      buffer.checkedFor === undefined &&
      buffer.draft === buffer.saved &&
      buffer.status === 'STATICALLY_VALIDATED';
    return `<p class="mu ed-empty">${esc(buffer.checkedFor === buffer.draft ? t.noDiagnostics : atGeneration ? t.noDiagnosticsGenerated : t.noDiagnosticsYet)}</p>`;
  }
  return DIAGNOSTIC_CATEGORIES.filter((category) => list.some((entry) => entry.category === category))
    .map((category) => {
      const entries = list.filter((entry) => entry.category === category);
      return `<section class="ed-dcat"><h4>${esc(t.categories[category] ?? category)} <span class="mu">(${String(entries.length)})</span></h4>${diagnosticList(state, entries, buffer.path)}</section>`;
    })
    .join('');
}

function runBlock(
  state: DashboardState,
  run: TestRunView | undefined,
  buffer: EditorBuffer,
  title: string,
): string {
  const t = state.t.ed;
  if (!run)
    return `<section class="ed-res"><h4>${esc(title)}</h4><p class="mu">${esc(t.noResult)}</p></section>`;
  const active = run.status === 'QUEUED' || run.status === 'RUNNING';
  const verdict = run.dryRunStatus
    ? `<span class="mu">${esc(t.dryRunStatuses[run.dryRunStatus] ?? run.dryRunStatus)}</span>`
    : '';
  const cases = run.cases
    .map(
      (entry) =>
        `<li><button data-action="ed-diag" data-path="${esc(buffer.path)}" ${entry.line !== undefined ? `data-line="${String(entry.line)}"` : ''} ${entry.step !== undefined ? `data-step="${String(entry.step)}"` : ''}>${pill(entry.status === 'BLOCKED' ? 'BLOCKED' : entry.status, state.t.tst.caseStatuses[entry.status] ?? entry.status)}<span class="ed-msg">${esc(entry.name)}</span><span class="ed-where">${esc([entry.detail, entry.message].filter(Boolean).join(' · '))}</span></button></li>`,
    )
    .join('');
  return `<section class="ed-res"><h4>${esc(title)}</h4><p class="ed-row">${pill(run.status === 'ERROR' ? 'FAILED' : run.status === 'UNAVAILABLE' ? 'SKIPPED' : run.status, state.t.tst.statuses[run.status] ?? run.status)}${verdict}<span class="mu">${esc(formatDate(run.startedAt ?? run.queuedAt, state.t.locale))} · ${esc(run.tool)}</span>${run.draft ? `<span class="ed-chip mu">${esc(t.fromDraft)}</span>` : ''}${
    active
      ? `<button class="btn" data-action="ed-cancel-run" data-run="${esc(run.id)}">${icon('stop')}<span>${esc(state.t.tst.cancel)}</span></button>`
      : ''
  }${run.report ? `<button class="btn" data-action="ed-report" data-run="${esc(run.id)}">${esc(state.t.tst.report)}</button>` : ''}</p>${run.message ? `<p class="${run.status === 'CANCELLED' ? 'mu' : 'err'}">${esc(run.message)}</p>` : ''}${cases ? `<ul class="ed-dlist">${cases}</ul>` : ''}${
    run.output
      ? `<details><summary>${esc(state.t.tst.output)}</summary><pre class="tst-code" tabindex="0">${esc(run.output)}</pre></details>`
      : ''
  }</section>`;
}

function bottomPanel(state: DashboardState, buffer: EditorBuffer): string {
  const t = state.t.ed;
  const ui = state.ed;
  const count = diagnosticsOf(ui, buffer.path).length;
  const runs = ui.view?.runs ?? [];
  const latest = (mode: 'RUN' | 'DRY_RUN'): TestRunView | undefined =>
    runs.find((run) => run.format === buffer.format && (run.mode ?? 'RUN') === mode);
  const kind = kindOf(buffer.path);
  const body =
    ui.panel === 'diagnostics'
      ? diagnosticsPanel(state, buffer)
      : `${kind === 'flow' || kind === 'feature' ? runBlock(state, latest('DRY_RUN'), buffer, t.lastDryRun) : ''}${runBlock(state, latest('RUN'), buffer, t.lastRun)}<p class="mu">${esc(t.staticOnly)}</p>`;
  return `<section class="ed-panel" aria-label="${esc(t.panel)}"><div class="ed-ptabs" role="tablist"><button role="tab" aria-selected="${ui.panel === 'diagnostics' ? 'true' : 'false'}" data-action="ed-panel" data-panel="diagnostics">${esc(t.diagnostics)} <span class="ed-count">${String(count)}</span></button><button role="tab" aria-selected="${ui.panel === 'results' ? 'true' : 'false'}" data-action="ed-panel" data-panel="results">${esc(t.results)}</button></div><div class="ed-pbody" role="tabpanel">${body}</div></section>`;
}

// ── L'écran ──────────────────────────────────────────────────────────────────────────────────

export function editorView(state: DashboardState): string {
  const t = state.t.ed;
  const ui = state.ed;
  if (!ui.view)
    return `<section class="ed"><header class="ed-top"><nav class="ed-crumbs"><button class="lnk" data-action="ed-back">${esc(state.t.nav.tests)}</button></nav></header><div class="msg" aria-busy="true"><span class="spin" aria-hidden="true"></span><p class="mu">${esc(t.loading)}</p></div></section>`;
  if (ui.view.files.length === 0)
    return `<section class="ed">${topBar(state, undefined)}<div class="msg"><p>${esc(t.noFiles)}</p><button class="btn primary" data-action="ed-back">${esc(t.toGenerate)}</button></div></section>`;
  const buffer = ui.active ? ui.buffers[ui.active] : undefined;
  let stage = `<div class="msg"><p class="mu">${esc(t.pickFile)}</p></div>`;
  if (ui.kit === 'error')
    stage = `<div class="msg" role="alert"><p class="err">${esc(t.kitError)}</p>${ui.kitError ? `<p class="mu">${esc(ui.kitError)}</p>` : ''}</div>`;
  else if (buffer) {
    const mode = modeOf(ui, buffer.path);
    const content =
      mode === 'compare'
        ? compareStage(state, buffer)
        : mode === 'visual'
          ? kindOf(buffer.path) === 'flow'
            ? flowVisual(state, buffer)
            : featureVisual(state, buffer)
          : `<div class="ed-cm" data-cm-host data-path="${esc(buffer.path)}">${ui.kit !== 'ready' ? `<div class="msg" aria-busy="true"><span class="spin" aria-hidden="true"></span><p class="mu">${esc(t.loadingEditor)}</p></div>` : ''}</div>`;
    stage = `${viewBar(state, buffer)}<div class="ed-stage" data-mode="${mode}">${content}</div>${bottomPanel(state, buffer)}`;
  } else if (ui.active)
    stage = `<div class="msg" aria-busy="true"><span class="spin" aria-hidden="true"></span><p class="mu">${esc(t.loading)}</p></div>`;
  return `<section class="ed" data-explorer="${ui.explorer ? 'open' : 'closed'}" data-inspector="${ui.inspector ? 'open' : 'closed'}" aria-label="${esc(t.title)}">
${topBar(state, buffer)}${banners(state)}
<div class="ed-body">${ui.explorer ? explorer(state) : ''}<div class="ed-center">${tabs(state)}${stage}</div>${ui.inspector && buffer ? inspector(state, buffer) : ''}</div>
</section>`;
}

/** Le chemin du premier fichier à ouvrir : celui demandé, sinon le flow YAML, sinon le premier. */
export function firstFile(files: readonly GeneratedFileView[], wanted?: string): string | undefined {
  if (wanted && files.some((file) => file.path === wanted)) return wanted;
  return files.find((file) => file.path.endsWith('.flow.yaml'))?.path ?? files[0]?.path;
}
