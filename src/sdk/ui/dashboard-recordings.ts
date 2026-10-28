import type { RecordingSnapshot } from '../core/contracts.js';
import { can } from './dashboard-access.js';
import type { DashboardState } from './dashboard-view.js';
import { formatDate, header, icon, pill } from './dashboard-parts.js';
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

export interface RecordingsUi {
  form: RecordingForm;
  busy?: boolean;
  error?: string;
  /** La session suivie en direct : son nom, son statut, ses derniers événements. */
  live?: { name: string; status: string; events: { at: string; text: string }[]; stopping?: boolean };
}

export const emptyRecordingsUi = (): RecordingsUi => ({ form: { name: '', startPath: '', validate: true } });

const LIVE = new Set(['RECORDING', 'PROCESSING']);
const TONE: Record<string, string> = {
  RECORDING: 'RUNNING',
  PROCESSING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  STORED: 'COMPLETED',
  FAILED: 'FAILED',
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
      ? `<a class="btn small" href="${esc(studioLink(state, recording.name))}" target="_blank" rel="noopener">${esc(r.openStudio)}</a>`
      : '',
    done && !isPromoted && !archived && can(state, 'PUBLISH') && summary
      ? `<button class="btn small" data-action="promote" data-recording="${esc(recording.name)}" ${state.promoting ? 'disabled' : ''}>${esc(state.promoting === recording.name ? t.ops.promoting : r.promote)}</button>`
      : '',
    isPromoted ? `<span class="mu">${esc(r.promoted)}</span>` : '',
  ].join('');
  return `<tr><th scope="row"><span class="mono">${esc(recording.name)}</span>${recording.startedAt ? `<small class="mu block">${esc(formatDate(recording.startedAt, t.locale))}</small>` : ''}</th><td>${pill(TONE[recording.status] ?? 'UNKNOWN', r.statuses[recording.status] ?? recording.status)}</td><td>${summary ? String(summary.steps) : '—'}</td><td>${summary ? String(summary.proposals.pending) : '—'}</td><td>${summary?.replay ? pill(REPLAY_TONE[summary.replay] ?? 'UNKNOWN', r.replays[summary.replay] ?? summary.replay) : '<span class="mu">—</span>'}</td><td><span class="row-acts">${actions}</span></td></tr>`;
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
  const liveCard = live
    ? `<section class="card live-rec" aria-live="polite"><div class="card-h"><h2>${esc(r.liveTitle)} · <span class="mono">${esc(live.name)}</span></h2>${pill(TONE[live.status] ?? 'UNKNOWN', r.statuses[live.status] ?? live.status)}</div>${
        live.events.length === 0
          ? `<p class="mu">${esc(r.waiting)}</p>`
          : `<ol class="plain tight rec-events">${live.events
              .slice(-8)
              .map(
                (event) =>
                  `<li><small class="mu">${esc(formatDate(event.at, t.locale))}</small> ${esc(event.text)}</li>`,
              )
              .join('')}</ol>`
      }${
        live.status === 'RECORDING' && mayRun
          ? `<div class="form-acts start"><button class="btn danger" data-action="stop-recording" ${live.stopping ? 'disabled' : ''}>${icon('stop')}<span>${esc(live.stopping ? r.stopping : r.stop)}</span></button></div>`
          : ''
      }</section>`
    : '';
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
