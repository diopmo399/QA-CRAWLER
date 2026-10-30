import type {
  GeneratedFileView,
  GeneratedTestsView,
  GenerationFormatName,
  TestRunView,
  TestRunnerView,
} from '../core/contracts.js';
import { GENERATION_FORMATS } from '../core/contracts.js';
import { can } from './dashboard-access.js';
import { formatDate, header, icon, pill } from './dashboard-parts.js';
import type { DashboardState } from './dashboard-view.js';
import { esc } from './view.js';

/**
 * LES TESTS GÉNÉRÉS : choisir un enregistrement, générer ses tests dans les formats voulus, puis les
 * exécuter pour de vrai. Chaque format dit l'outil qui le joue sur ce serveur (le moteur QA-CRAWLER,
 * Playwright Test, Maven), s'il est présent, et ce qu'il garantit (la SafetyPolicy pour le rejeu du
 * moteur ; aucune pour les tests autonomes). Un statut d'exécution ne vient que d'une exécution : les
 * fichiers gardent leur statut de génération (généré, vérifié statiquement). Des fonctions pures.
 */
export interface TestsUi {
  /** L'enregistrement affiché. */
  recording?: string;
  view?: GeneratedTestsView;
  /** Les formats cochés pour la génération. */
  formats: GenerationFormatName[];
  /** L'environnement choisi pour le rejeu du moteur ('' : la cible du projet). */
  environment: string;
  /** Le fichier dont le contenu est ouvert, l'exécution dont le détail est ouvert. */
  file?: string;
  run?: string;
  /** 'generate' ou le format dont l'exécution se lance. */
  busy?: string;
  error?: string;
  details?: string[];
  notice?: string;
  /** Le fichier dont le retour à la version générée attend sa confirmation. */
  confirmRestore?: string;
  /** Une régénération qui remplacerait des fichiers modifiés à la main : ces fichiers, à confirmer. */
  overwrite?: string[];
}

export const emptyTestsUi = (): TestsUi => ({ formats: ['yaml', 'playwright'], environment: '' });

const ACTIVE = new Set(['QUEUED', 'RUNNING']);

export const activeRuns = (view: GeneratedTestsView | undefined): TestRunView[] =>
  (view?.runs ?? []).filter((run) => ACTIVE.has(run.status));

const RUN_TONE: Record<string, string> = { ERROR: 'FAILED', UNAVAILABLE: 'SKIPPED' };
const FILE_TONE: Record<string, string> = {
  STATICALLY_VALIDATED: 'CONFIRMED',
  GENERATED: 'PENDING',
  NOT_VALIDATED: 'INCOMPLETE',
};

function runPill(state: DashboardState, status: string): string {
  return pill(RUN_TONE[status] ?? status, state.t.tst.statuses[status] ?? status);
}

/** Les enregistrements terminés (écrits sur disque) : les seuls qui se génèrent. */
export const finishedRecordings = (state: DashboardState): string[] =>
  (state.recordings ?? [])
    .filter((recording) => recording.status === 'COMPLETED' || recording.status === 'STORED')
    .map((recording) => recording.name);

/** Le statut le moins avancé des fichiers d'un format (un seul fichier non vérifié suffit à le dire). */
function formatFileStatus(files: readonly GeneratedFileView[]): string | undefined {
  const order = ['GENERATED', 'NOT_VALIDATED', 'STATICALLY_VALIDATED'];
  return files.map((file) => file.status).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
}

function formatCard(state: DashboardState, format: GenerationFormatName): string {
  const t = state.t.tst;
  const ui = state.tst;
  const view = ui.view;
  const runner: TestRunnerView | undefined = view?.runners.find((entry) => entry.format === format);
  const files = (view?.files ?? []).filter((file) => file.format === format);
  const status = formatFileStatus(files);
  const last = view?.runs.find((run) => run.format === format);
  const active = last !== undefined && ACTIVE.has(last.status);
  const engine = runner?.kind === 'ENGINE';
  const allowed = can(state, 'RUN') && (engine || can(state, 'RUN_WRITES'));
  const reason = !runner?.available
    ? (runner?.reason ?? t.unavailable)
    : files.length === 0
      ? t.notGenerated
      : !allowed
        ? t.noRight
        : undefined;
  const environments = state.project?.environments ?? [];
  const pick =
    engine && environments.length > 0
      ? `<label class="tst-env"><span>${esc(t.environment)}</span><select data-tst="environment"><option value="">${esc(t.projectTarget)}</option>${environments
          .map(
            (environment) =>
              `<option value="${esc(environment.id)}" ${environment.id === ui.environment ? 'selected' : ''}>${esc(environment.name)}</option>`,
          )
          .join('')}</select></label>`
      : '';
  const lastLine = last
    ? `<p class="tst-last"><span>${esc(t.lastRun)}</span>${runPill(state, last.status)}${last.counts.total > 0 ? `<small>${esc(t.counts(last.counts.passed, last.counts.failed, last.counts.skipped, last.counts.total))}</small>` : ''}</p>`
    : '';
  const button = active
    ? `<button class="btn" data-action="tst-cancel" data-run="${esc(last.id)}">${icon('stop')}<span>${esc(t.cancel)}</span></button>`
    : `<button class="btn primary" data-action="tst-run" data-format="${format}" ${reason || ui.busy !== undefined ? 'disabled' : ''} ${reason ? `aria-describedby="tst-why-${format}"` : ''}>${icon('play')}<span>${esc(ui.busy === format ? t.running : t.run)}</span></button>`;
  return `<article class="tst-fmt" data-format="${format}">
<header><h3>${esc(t.formats[format] ?? format)}</h3><span class="tst-pills">${status ? pill(FILE_TONE[status] ?? status, t.fileStatuses[status] ?? status) : `<span class="pill mu">${esc(t.notGenerated)}</span>`}${files.some((file) => file.editedAt) ? `<span class="pill warn">${esc(t.editedByHand)}</span>` : ''}</span></header>
<p class="mu">${esc(t.formatHint[format] ?? '')}</p>
<dl class="tst-kv"><dt>${esc(t.tool)}</dt><dd>${esc(runner?.tool ?? '—')}${runner && !runner.available ? ` <span class="pill ko">${esc(t.unavailable)}</span>` : ''}</dd></dl>
<p class="tst-safety ${engine ? 'ok' : 'warn'}">${icon(engine ? 'check' : 'alert')}<span>${esc(engine ? t.engineSafety : `${t.externalSafety} ${t.externalTarget}`)}</span></p>
${lastLine}${pick}
<div class="tst-go">${button}${reason && !active ? `<small class="mu" id="tst-why-${format}">${esc(reason)}</small>` : ''}</div>
</article>`;
}

/** Un fichier se modifie avec le droit de générer ; un test Playwright ou Java demande aussi RUN_WRITES. */
export function canEdit(state: DashboardState, file: GeneratedFileView): boolean {
  if (file.revision === undefined || !can(state, 'DECIDE')) return false;
  return file.format === 'yaml' || file.format === 'gherkin' || can(state, 'RUN_WRITES');
}

function fileRow(state: DashboardState, file: GeneratedFileView): string {
  const t = state.t.tst;
  const open = state.tst.file === file.path;
  const validation = file.validation
    ? `<p class="mu">${esc(t.validation)} : ${esc(file.validation.method)}</p>${
        file.validation.messages.length > 0
          ? `<ul class="tst-msgs">${file.validation.messages.map((message) => `<li>${esc(message)}</li>`).join('')}</ul>`
          : ''
      }`
    : '';
  const assertions =
    file.assertions.length > 0
      ? `<p class="mu">${esc(t.assertions(file.assertions.length))}</p><ul class="tst-msgs">${file.assertions
          .map(
            (assertion) =>
              `<li>${esc(assertion.description)}${assertion.support === 'REPLAY_ONLY' ? ` <small class="mu">(${esc(t.replayOnly)})</small>` : ''}</li>`,
          )
          .join('')}</ul>`
      : '';
  const limits =
    file.limits.length > 0
      ? `<p class="mu">${esc(t.limits)}</p><ul class="tst-msgs warn">${file.limits.map((limit) => `<li>${esc(limit)}</li>`).join('')}</ul>`
      : '';
  const edited = file.editedAt
    ? `<span class="pill warn" title="${esc(formatDate(file.editedAt, state.t.locale))}">${esc(t.editedByHand)}</span>`
    : '';
  const restoring = state.tst.confirmRestore === file.path;
  // Modifier se fait dans l'éditeur (vue visuelle, source, diagnostics, comparaison) ; ici, la lecture.
  const actions = open
    ? `<div class="tst-go"><button class="btn" data-action="tst-open-editor" data-path="${esc(file.path)}">${icon('editor')}<span>${esc(state.t.ed.open)}</span></button>${
        canEdit(state, file) && file.editedAt && !restoring
          ? `<button class="btn" data-action="tst-restore" data-path="${esc(file.path)}">${icon('undo')}<span>${esc(t.restore)}</span></button>`
          : ''
      }</div>${
        restoring
          ? `<div class="tst-confirm" role="group" aria-label="${esc(t.restore)}"><p>${esc(t.restoreConfirm)}</p><div class="tst-go"><button class="btn danger" data-action="tst-restore-confirm" data-path="${esc(file.path)}">${esc(t.restore)}</button><button class="btn" data-action="tst-restore-cancel">${esc(t.cancelEdit)}</button></div></div>`
          : ''
      }`
    : '';
  const body = `${file.editedAt ? `<p class="mu">${esc(t.editedNote(formatDate(file.editedAt, state.t.locale)))}</p>` : ''}${validation}${assertions}${limits}${actions}<pre class="tst-code" tabindex="0">${esc(file.content)}</pre>`;
  return `<li class="tst-file${file.editedAt ? ' edited' : ''}">
<div class="tst-file-h"><span class="pill mu">${esc(file.format)}</span><code>${esc(file.path)}</code>${pill(FILE_TONE[file.status] ?? file.status, t.fileStatuses[file.status] ?? file.status)}${edited}<button class="lnk" data-action="tst-file" data-path="${esc(file.path)}" aria-expanded="${open ? 'true' : 'false'}">${esc(open ? t.hide : t.show)}</button></div>
${open ? `<div class="tst-file-b">${body}</div>` : ''}
</li>`;
}

function runRow(state: DashboardState, run: TestRunView): string {
  const t = state.t.tst;
  const open = state.tst.run === run.id;
  const duration = run.durationMs !== undefined ? t.seconds(run.durationMs) : '—';
  const cases =
    run.cases.length > 0
      ? `<ul class="tst-cases">${run.cases
          .map(
            (entry) =>
              `<li>${pill(entry.status, t.caseStatuses[entry.status] ?? entry.status)}<span class="tst-case-n">${esc(entry.name)}</span>${entry.durationMs !== undefined ? `<small class="mu">${esc(t.seconds(entry.durationMs))}</small>` : ''}${entry.message ? `<p class="tst-case-m">${esc(entry.message)}</p>` : ''}</li>`,
          )
          .join('')}</ul>`
      : `<p class="mu">${esc(t.noCases)}</p>`;
  const detail = open
    ? `<div class="tst-run-b">
<dl class="tst-kv"><dt>${esc(t.tool)}</dt><dd>${esc(run.tool)}</dd><dt>${esc(t.target)}</dt><dd><code>${esc(run.target)}</code>${run.environment ? ` · ${esc(run.environment.name)}` : ''}</dd></dl>
${run.message ? `<p class="${run.status === 'CANCELLED' ? 'mu' : 'err'}">${esc(run.message)}</p>` : ''}
${run.edited && run.edited.length > 0 ? `<p class="tst-safety warn">${icon('alert')}<span>${esc(t.playedEdited(run.edited.join(', ')))}</span></p>` : ''}
<h4>${esc(t.cases)}</h4>${cases}
${run.report ? `<button class="btn" data-action="tst-report" data-run="${esc(run.id)}">${icon('download')}<span>${esc(t.report)}</span></button>` : ''}
${run.output ? `<details class="tst-out"><summary>${esc(t.output)}</summary><pre class="tst-code" tabindex="0">${esc(run.output)}</pre></details>` : ''}
</div>`
    : '';
  return `<li class="tst-run" data-status="${esc(run.status)}">
<div class="tst-run-h">${runPill(state, run.status)}<b>${esc(t.formats[run.format] ?? run.format)}</b><span class="mu">${esc(formatDate(run.startedAt ?? run.queuedAt, state.t.locale))}</span><span class="mu">${esc(duration)}</span>${run.counts.total > 0 ? `<span>${esc(t.counts(run.counts.passed, run.counts.failed, run.counts.skipped, run.counts.total))}</span>` : ''}<button class="lnk" data-action="tst-open-run" data-run="${esc(run.id)}" aria-expanded="${open ? 'true' : 'false'}">${esc(t.details)}</button></div>
${detail}
</li>`;
}

export function testsView(state: DashboardState): string {
  const t = state.t.tst;
  const ui = state.tst;
  const recordings = finishedRecordings(state);
  const project = state.project?.name ?? '';
  const actions = `${ui.view && ui.view.files.length > 0 ? `<button class="btn" data-action="tst-open-editor">${icon('editor')}<span>${esc(state.t.ed.open)}</span></button>` : ''}<button class="btn icon-only" data-action="refresh" aria-label="${esc(t.refresh)}">${icon('refresh')}</button>`;
  const head = header(esc(t.title), { sub: esc(t.sub(project, recordings.length)), actions });
  if (recordings.length === 0)
    return `${head}<p class="mu tst-intro">${esc(t.intro)}</p><section class="card"><p class="mu">${esc(t.noRecording)}</p></section>`;
  const view = ui.view;
  const picker = `<label class="tst-pick"><span>${esc(t.recording)}</span><select data-tst="recording">${recordings
    .map(
      (name) =>
        `<option value="${esc(name)}" ${name === ui.recording ? 'selected' : ''}>${esc(name)}</option>`,
    )
    .join('')}</select></label>`;
  const feedback = `${ui.notice ? `<p class="ok" role="status">${esc(ui.notice)}</p>` : ''}${
    ui.error
      ? `<div class="err" role="alert"><p>${esc(ui.error)}</p>${ui.details && ui.details.length > 0 ? `<ul>${ui.details.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>` : ''}</div>`
      : ''
  }`;
  const decide = can(state, 'DECIDE');
  const generate = `<section class="card tst-gen"><div class="card-h"><h2>${esc(t.generateTitle)}</h2>${view?.generatedAt ? `<p class="mu">${esc(t.generatedAt(formatDate(view.generatedAt, state.t.locale)))}</p>` : ''}</div>
<form data-action="tst-generate"><fieldset><legend class="mu">${esc(t.generateHint)}</legend><div class="tst-checks">${GENERATION_FORMATS.map(
    (format) =>
      `<label class="tst-check"><input type="checkbox" data-tst="format" value="${format}" ${ui.formats.includes(format) ? 'checked' : ''} ${decide ? '' : 'disabled'}><span><b>${esc(t.formats[format] ?? format)}</b><small>${esc(t.formatHint[format] ?? '')}</small></span></label>`,
  ).join('')}</div></fieldset>
<div class="tst-go"><button class="btn primary" type="submit" ${!decide || ui.busy !== undefined || ui.formats.length === 0 ? 'disabled' : ''}>${icon('plus')}<span>${esc(ui.busy === 'generate' ? t.generating : t.generate)}</span></button>${ui.formats.length === 0 ? `<small class="mu">${esc(t.pickFormat)}</small>` : ''}${decide ? '' : `<small class="mu">${esc(t.noRight)}</small>`}</div></form>
${
  ui.overwrite
    ? `<div class="tst-confirm" role="alert"><p>${esc(t.overwriteWarn)}</p><ul class="tst-msgs warn">${ui.overwrite.map((file) => `<li><code>${esc(file)}</code></li>`).join('')}</ul><div class="tst-go"><button class="btn" data-action="tst-overwrite-compare">${icon('history')}<span>${esc(t.compareFirst)}</span></button><button class="btn danger" data-action="tst-overwrite" ${ui.busy !== undefined ? 'disabled' : ''}>${esc(t.overwrite)}</button><button class="btn" data-action="tst-overwrite-cancel">${esc(t.cancelEdit)}</button></div></div>`
    : ''
}
${view && view.warnings.length > 0 ? `<ul class="tst-msgs warn">${view.warnings.map((warning) => `<li>${esc(warning)}</li>`).join('')}</ul>` : ''}
</section>`;
  const run = `<section class="card"><div class="card-h"><h2>${esc(t.runTitle)}</h2></div><div class="tst-fmts">${GENERATION_FORMATS.map((format) => formatCard(state, format)).join('')}</div></section>`;
  const files = view
    ? `<section class="card"><div class="card-h"><h2>${esc(t.filesTitle)}</h2></div>${
        view.files.length > 0
          ? `<ul class="tst-files">${view.files.map((file) => fileRow(state, file)).join('')}</ul>`
          : `<p class="mu">${esc(view.generatedAt ? t.noFiles : t.neverGenerated)}</p>`
      }</section>`
    : '';
  const runs = view
    ? `<section class="card"><div class="card-h"><h2>${esc(t.runsTitle)}</h2></div>${
        view.runs.length > 0
          ? `<ul class="tst-runs">${view.runs.map((entry) => runRow(state, entry)).join('')}</ul>`
          : `<p class="mu">${esc(t.noRuns)}</p>`
      }</section>`
    : '';
  return `${head}<p class="mu tst-intro">${esc(t.intro)}</p><div class="tst-bar">${picker}</div>${feedback}${generate}${run}${runs}${files}`;
}
