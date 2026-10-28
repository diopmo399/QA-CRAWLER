import type { LiveStepView, LiveTimelineView, RecordingSnapshot } from '../core/contracts.js';
import { can } from './dashboard-access.js';
import type { DashboardState } from './dashboard-view.js';
import { formatDate, formatTime, header, icon, pill } from './dashboard-parts.js';
import { esc } from './view.js';

/**
 * L'ÉCRAN ENREGISTREMENTS : démarrer l'enregistrement d'un parcours joué par une personne (le
 * navigateur s'ouvre sur la machine du serveur), le suivre en direct, l'arrêter ; puis la liste des
 * enregistrements du projet, avec le lien vers le Flow Studio et la promotion en scénario. Les
 * événements montrés sont ceux du serveur (type de geste et libellé de la cible), jamais une valeur
 * saisie.
 */
export interface RecordingForm {
  name: string;
  startPath: string;
  validate: boolean;
}

/** La session suivie en direct : ses gestes, ses vérifications, puis les phases du traitement. */
export interface LiveRecording {
  name: string;
  status: string;
  timeline?: LiveTimelineView;
  /** Les moments qui comptent pour la personne (démarré, en pause, geste annulé…). */
  notes: { at: string; text: string }[];
  /** Après l'arrêt : les phases franchies, la dernière en cours. */
  phases: { label: string; step?: number; total?: number; detail?: string }[];
  /** Tous les messages du recorder, tels quels (repliés). */
  technical: { at: string; text: string }[];
  checkpointLabel: string;
  stopping?: boolean;
  /** La commande en cours d'envoi (pause, undo…) : son bouton est désactivé. */
  control?: string;
  error?: string;
}

export interface RecordingsUi {
  form: RecordingForm;
  busy?: boolean;
  error?: string;
  live?: LiveRecording;
}

export const newLiveRecording = (name: string, status: string): LiveRecording => ({
  name,
  status,
  notes: [],
  phases: [],
  technical: [],
  checkpointLabel: '',
});

export const emptyRecordingsUi = (): RecordingsUi => ({ form: { name: '', startPath: '', validate: true } });

const LIVE = new Set(['RECORDING', 'PROCESSING']);
const TONE: Record<string, string> = {
  RECORDING: 'RUNNING',
  PROCESSING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  STORED: 'COMPLETED',
  FAILED: 'FAILED',
};
const STEP_TONE: Record<string, string> = {
  PENDING: 'RUNNING',
  CONFIRMED: 'PASSED',
  AMBIGUOUS: 'INCOMPLETE',
  FAILED: 'FAILED',
  UNVERIFIED: 'UNKNOWN',
};
const REPLAY_TONE: Record<string, string> = {
  REPLAY_CONFIRMED: 'PASSED',
  REPLAY_FAILED: 'FAILED',
  NOT_VALIDATED: 'UNKNOWN',
};

/** Le lien vers le Flow Studio d'un enregistrement (même serveur que l'API). */
export function studioLink(state: DashboardState, recording: string): string {
  const project = state.project?.id ?? '';
  return `${state.studioUrl ?? '/studio'}?project=${encodeURIComponent(project)}&recording=${encodeURIComponent(recording)}`;
}

function row(state: DashboardState, recording: RecordingSnapshot, promoted: Set<string>): string {
  const t = state.t;
  const r = t.rec;
  const summary = recording.summary;
  const done = recording.status === 'COMPLETED' || recording.status === 'STORED';
  const isPromoted = promoted.has(recording.name);
  const archived = state.project?.state === 'ARCHIVED';
  const actions = [
    done
      ? `<button class="btn small primary" data-action="open-review" data-recording="${esc(recording.name)}">${esc(t.review.open)}</button>`
      : '',
    done
      ? `<a class="btn small" href="${esc(studioLink(state, recording.name))}" target="_blank" rel="noopener">${esc(r.openStudio)}</a>`
      : '',
    done && !isPromoted && !archived && can(state, 'PUBLISH') && summary
      ? `<button class="btn small" data-action="promote" data-recording="${esc(recording.name)}" ${state.promoting ? 'disabled' : ''}>${esc(state.promoting === recording.name ? t.ops.promoting : r.promote)}</button>`
      : '',
    isPromoted ? `<span class="mu">${esc(r.promoted)}</span>` : '',
  ].join('');
  return `<tr><th scope="row"><span class="mono">${esc(recording.name)}</span>${recording.startedAt ? `<small class="mu block">${esc(formatDate(recording.startedAt, t.locale))}</small>` : ''}</th><td>${pill(TONE[recording.status] ?? 'UNKNOWN', r.statuses[recording.status] ?? recording.status)}</td><td>${summary ? String(summary.steps) : '—'}</td><td>${summary ? String(summary.proposals.pending) : '—'}</td><td>${summary?.replay ? pill(REPLAY_TONE[summary.replay] ?? 'UNKNOWN', r.replays[summary.replay] ?? summary.replay) : '<span class="mu">—</span>'}</td><td><span class="row-acts">${actions}</span></td></tr>`;
}

function stepView(state: DashboardState, step: LiveStepView, mayRun: boolean, busy: boolean): string {
  const r = state.t.rec;
  const choose =
    step.status === 'AMBIGUOUS' && !step.resolution && step.candidates && step.candidates.length > 0 && mayRun
      ? `<div class="amb" role="group" aria-label="${esc(r.ambiguous)}"><small>${esc(r.ambiguous)}</small><div class="row-acts">${step.candidates
          .map(
            (candidate) =>
              `<button class="btn small" data-action="rec-resolve" data-step="${esc(step.id)}" data-candidate="${String(candidate.index)}" ${busy ? 'disabled' : ''}>${esc(candidate.label)}${candidate.original ? ` <small class="mu">(${esc(r.touched)})</small>` : ''}</button>`,
          )
          .join(
            '',
          )}<button class="btn small ghost" data-action="rec-ignore" data-step="${esc(step.id)}" ${busy ? 'disabled' : ''}>${esc(r.leaveAmbiguous)}</button></div></div>`
      : '';
  const resolution = step.resolution ? ` · ${r.resolutions[step.resolution] ?? step.resolution}` : '';
  return `<li class="live-step"><span class="n" aria-hidden="true">${String(step.index)}</span><span class="ls-main"><b>${esc(step.description)}</b>${step.detail ? `<small class="mu block">${esc(step.detail)}</small>` : ''}<small class="mu block">${esc(step.statusText)}${esc(resolution)}</small>${choose}</span>${pill(STEP_TONE[step.status] ?? 'UNKNOWN', r.stepStatuses[step.status] ?? step.status)}</li>`;
}

/** La carte de la session en cours : les gestes et la barre d'enregistrement, puis le traitement après l'arrêt. */
function liveView(state: DashboardState, live: LiveRecording, mayRun: boolean): string {
  const t = state.t;
  const r = t.rec;
  const timeline = live.timeline;
  const recording = live.status === 'RECORDING';
  const paused = recording && timeline?.paused === true;
  const busy = live.control !== undefined || live.stopping === true;
  const statusPill = paused
    ? pill('PAUSED', r.paused)
    : pill(TONE[live.status] ?? 'UNKNOWN', r.statuses[live.status] ?? live.status);
  const bar =
    recording && mayRun
      ? `<div class="rec-bar" role="toolbar" aria-label="${esc(r.liveTitle)}">${
          paused
            ? `<button class="btn" data-action="rec-control" data-control="resume" ${busy ? 'disabled' : ''}>${icon('play')}<span>${esc(r.resume)}</span></button>`
            : `<button class="btn" data-action="rec-control" data-control="pause" ${busy ? 'disabled' : ''}>${icon('pause')}<span>${esc(r.pause)}</span></button>`
        }<button class="btn" data-action="rec-control" data-control="undo" ${busy || !timeline?.steps.length ? 'disabled' : ''}>${icon('undo')}<span>${esc(r.undo)}</span></button><button class="btn danger" data-action="stop-recording" ${live.stopping ? 'disabled' : ''}>${icon('stop')}<span>${esc(live.stopping ? r.stopping : r.stop)}</span></button></div><form class="rec-check" data-action="rec-checkpoint"><label class="field">${esc(r.checkpointField)}<input data-rec="checkpoint" value="${esc(live.checkpointLabel)}" placeholder="${esc(r.checkpointPlaceholder)}" maxlength="80" autocomplete="off"></label><button type="submit" class="btn" ${busy ? 'disabled' : ''}>${icon('check')}<span>${esc(r.addCheckpoint)}</span></button></form>`
      : '';
  const steps = timeline?.steps ?? [];
  const stepList =
    steps.length === 0
      ? recording
        ? `<p class="mu">${esc(r.waiting)}</p>`
        : ''
      : `<h3 class="section-t">${esc(r.stepsTitle)} · ${String(steps.length)}</h3><ol class="plain live-steps">${steps
          .map((step) => stepView(state, step, mayRun && recording, busy))
          .join('')}</ol>`;
  const checkpoints =
    timeline && timeline.checkpoints.length > 0
      ? `<h3 class="section-t">${esc(r.checkpointsTitle)}</h3><ul class="plain tight rec-checks">${timeline.checkpoints
          .map((label) => `<li>${icon('check')} ${esc(label)}</li>`)
          .join('')}</ul>`
      : '';
  const last = live.phases.at(-1);
  const processing =
    live.status === 'PROCESSING' && last
      ? `<div class="rec-phases"><h3 class="section-t">${esc(r.processingTitle)}${last.step && last.total ? ` · ${esc(r.phaseOf(Math.min(last.step, last.total), last.total))}` : ''}</h3>${
          last.total
            ? `<div class="prog" aria-hidden="true"><span style="width:${String(Math.round((Math.min(last.step ?? 0, last.total) / last.total) * 100))}%"></span></div>`
            : ''
        }<ol class="plain tight">${live.phases
          .map(
            (phase, index) =>
              `<li class="${index === live.phases.length - 1 ? 'now' : 'done'}">${index === live.phases.length - 1 ? '<span class="spin" aria-hidden="true"></span>' : icon('check')} ${esc(r.phases[phase.label] ?? phase.label)}${index === live.phases.length - 1 && phase.detail ? ` <small class="mu">${esc(phase.detail)}</small>` : ''}</li>`,
          )
          .join('')}</ol></div>`
      : '';
  const notes =
    live.notes.length > 0
      ? `<ul class="plain tight rec-notes">${live.notes
          .slice(-4)
          .map(
            (note) =>
              `<li><small class="mu">${esc(formatTime(note.at, t.locale))}</small> ${esc(note.text)}</li>`,
          )
          .join('')}</ul>`
      : '';
  const technical =
    live.technical.length > 0
      ? `<details class="tech"><summary>${esc(r.technical)} · ${String(live.technical.length)}</summary><ol class="plain tight rec-events">${live.technical
          .slice(-40)
          .map(
            (event) =>
              `<li><small class="mu">${esc(formatTime(event.at, t.locale))}</small> ${esc(event.text)}</li>`,
          )
          .join('')}</ol></details>`
      : '';
  return `<section class="card live-rec" aria-live="polite"><div class="card-h"><h2>${esc(r.liveTitle)} · <span class="mono">${esc(live.name)}</span></h2>${statusPill}</div>${bar}${live.error ? `<p class="err" role="alert">${esc(live.error)}</p>` : ''}${processing}${stepList}${checkpoints}${notes}${technical}</section>`;
}

export function recordingsView(state: DashboardState): string {
  const t = state.t;
  const r = t.rec;
  const p = state.project;
  if (!p)
    return `${header(esc(t.nav.recordings))}<section class="msg"><span class="spin" aria-hidden="true"></span><p class="mu">${esc(t.loading)}</p></section>`;
  const ui = state.recs;
  const list = state.recordings ?? [];
  const live = ui.live;
  const busyElsewhere = list.some((recording) => LIVE.has(recording.status) && recording.name !== live?.name);
  const archived = p.state === 'ARCHIVED';
  const mayRun = can(state, 'RUN') && !archived;
  const form = !mayRun
    ? ''
    : `<section class="card"><h2>${esc(r.newTitle)}</h2><form class="col rec-form" data-action="recording-form"><div class="fields"><label class="field">${esc(r.name)}<input data-rec="name" value="${esc(ui.form.name)}" placeholder="${esc(r.namePlaceholder)}" maxlength="80" autocomplete="off"></label><label class="field">${esc(r.startPath)}<input data-rec="startPath" value="${esc(ui.form.startPath)}" placeholder="/" class="mono" autocomplete="off" spellcheck="false"></label></div><label class="chk"><input type="checkbox" data-rec="validate" ${ui.form.validate ? 'checked' : ''}> ${esc(r.validate)}</label><p class="note">${icon('alert')}<span>${esc(r.howTo)}</span></p><div class="form-acts start"><button type="button" class="btn primary" data-action="start-recording" ${ui.busy || live || busyElsewhere ? 'disabled' : ''}>${icon('play')}<span>${esc(ui.busy ? r.starting : r.start)}</span></button>${busyElsewhere || live ? `<small class="mu">${esc(r.oneAtATime)}</small>` : ''}</div>${ui.error ? `<p class="err" role="alert">${esc(ui.error)}</p>` : ''}</form></section>`;
  const liveCard = live ? liveView(state, live, mayRun) : '';
  const promoted = new Set(
    p.scenarios.map((scenario) => scenario.fromRecording).filter((name): name is string => Boolean(name)),
  );
  const table =
    list.length === 0
      ? `<p class="mu">${esc(r.none)}</p>`
      : `<div class="tw"><table class="tbl"><thead><tr><th scope="col">${esc(r.colName)}</th><th scope="col">${esc(r.colStatus)}</th><th scope="col">${esc(r.colSteps)}</th><th scope="col">${esc(r.colProposals)}</th><th scope="col">${esc(r.colReplay)}</th><th scope="col">${esc(r.colActions)}</th></tr></thead><tbody>${[
          ...list,
        ]
          .sort(
            (a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '') || a.name.localeCompare(b.name),
          )
          .map((recording) => row(state, recording, promoted))
          .join('')}</tbody></table></div>`;
  return `${header(esc(t.nav.recordings), { sub: esc(r.sub(p.name, list.length)) })}<div class="split"><div class="col">${liveCard}${form}</div></div><section class="card wide"><h2>${esc(r.listTitle)}</h2>${table}<p class="mu">${esc(r.cliNote)}</p></section>`;
}
