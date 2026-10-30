import type {
  AssertionProposalView,
  CorrectionView,
  DataInputView,
  IntentReviewView,
  RowSourceView,
  FlowStudioView,
  GenerationResult,
  GroupCheckView,
  GroupProposalView,
  GroupViewDto,
  RecordingReplayView,
  StudioStep,
  TestDataView,
} from '../core/contracts.js';
import { GENERATION_FORMATS } from '../core/contracts.js';
import { can } from './dashboard-access.js';
import { formatDate, header, icon, pill } from './dashboard-parts.js';
import type { DashboardState } from './dashboard-view.js';
import { studioLink } from './dashboard-recordings.js';
import { publishTab, reviewFacts, type PublishUi } from './dashboard-publish.js';
import { enginePhrase } from './engine-phrases.js';
import { esc } from './view.js';

/**
 * LA REVUE D'UN ENREGISTREMENT, dans le Dashboard : ce que la fenêtre du recorder fait après l'arrêt,
 * sur l'enregistrement écrit. Le parcours (étapes, groupes, découpage proposé, vérifications de
 * groupe, retrait d'une étape), les assertions (décisions une à une ou en lot), la source des données
 * de chaque saisie, la génération des tests et le rejeu de validation. Chaque décision passe par le
 * serveur, qui réécrit le flow : la page ne décide rien seule. Des fonctions pures.
 */
/** Une phrase du moteur dans la langue du Dashboard (la tournure inconnue reste telle quelle). */
const phrase = (state: DashboardState, text: string): string => enginePhrase(text, state.t.locale);

export const REVIEW_TABS = ['flow', 'assertions', 'data', 'intents', 'tests', 'publish'] as const;
export type ReviewTab = (typeof REVIEW_TABS)[number];

/** Le choix de source d'une saisie, tel que saisi avant l'envoi. */
export interface BindForm {
  source: 'FIXED' | 'GENERATED' | 'REFERENCE';
  variable: string;
  generator: string;
  reference: string;
  value: string;
}

export interface ReviewUi {
  name: string;
  studio?: FlowStudioView;
  assertions?: AssertionProposalView[];
  data?: TestDataView;
  groupProposals?: GroupProposalView[];
  checks?: GroupCheckView[];
  replay?: RecordingReplayView;
  generation?: GenerationResult;
  /** Les étapes cochées (création d'un groupe, ajout, détachement). */
  selected: string[];
  newGroup: string;
  renaming?: { id: string; name: string };
  editing?: { id: string; description: string };
  /** L'étape dont le retrait attend la confirmation (dans la page). */
  confirmRemove?: string;
  formats: string[];
  genGroups: string[];
  binds: Record<string, BindForm>;
  intents?: IntentReviewView;
  /** La correction d'une intention en cours de saisie. */
  intentEdit?: { actionId: string; intent: string; reason: string };
  /** La session de correction de cible ouverte pour cet enregistrement, et le choix de ligne. */
  correction?: CorrectionView;
  correctionChoice: { option?: string; column?: string; key?: string };
  /** La ligne en cours de redéfinition : ses cellules et le choix colonne par colonne. */
  rowEdit?: { stepId: string; source?: RowSourceView; columns: Record<string, RowChoice> };
  /** L'opération en cours d'envoi : les boutons sont désactivés. */
  busy?: string;
  error?: string;
  warnings?: string[];
  /** La publication de groupes métier dans la bibliothèque (onglet Publier). */
  publish?: PublishUi;
}

/** Une colonne de la ligne, telle que choisie avant l'envoi. */
export interface RowChoice {
  on: boolean;
  source: 'recorded' | 'value' | 'variable' | 'new-variable';
  value: string;
  key: string;
  contains: boolean;
}

export const emptyReviewUi = (name: string): ReviewUi => ({
  name,
  selected: [],
  newGroup: '',
  formats: ['yaml', 'gherkin'],
  genGroups: [],
  binds: {},
  correctionChoice: {},
});

/** Les colonnes choisies, prêtes à envoyer (seules celles cochées). */
export function rowColumnsOf(ui: ReviewUi): {
  column: string;
  source: RowChoice['source'];
  value?: string;
  key?: string;
  match?: 'exact' | 'contains';
}[] {
  return Object.entries(ui.rowEdit?.columns ?? {})
    .filter(([, choice]) => choice.on)
    .map(([column, choice]) => ({
      column,
      source: choice.source,
      ...(choice.source === 'value' || choice.source === 'new-variable' ? { value: choice.value } : {}),
      ...(choice.source === 'variable' || choice.source === 'new-variable' ? { key: choice.key.trim() } : {}),
      match: choice.contains ? 'contains' : 'exact',
    }));
}

/** Une session de correction attend-elle le serveur (rejeu, désignation, reprise) ? */
export const correctionWaiting = (view: CorrectionView | undefined): boolean =>
  view !== undefined && ['REPLAYING', 'PICKING', 'RESUMING'].includes(view.status);

/** Les propositions encore à décider, rangées comme dans la fenêtre du recorder. */
export function assertionBuckets(list: readonly AssertionProposalView[]): {
  recommended: AssertionProposalView[];
  toDecide: AssertionProposalView[];
  weak: AssertionProposalView[];
  decided: AssertionProposalView[];
} {
  const pending = list.filter((proposal) => proposal.status === 'PROPOSED');
  const weak = pending.filter(
    (proposal) => proposal.verificationMethod === 'REPORT_ONLY' || proposal.confidence < 0.5,
  );
  const recommended = pending.filter(
    (proposal) =>
      !weak.includes(proposal) &&
      proposal.origin === 'OBSERVED' &&
      proposal.confidence >= 0.75 &&
      (proposal.conflictsWith?.length ?? 0) === 0,
  );
  return {
    recommended,
    toDecide: pending.filter((proposal) => !weak.includes(proposal) && !recommended.includes(proposal)),
    weak,
    decided: list.filter((proposal) => proposal.status !== 'PROPOSED'),
  };
}

/** La saisie telle qu'affichée dans le formulaire : le choix en cours, sinon la liaison actuelle. */
export function bindFormOf(ui: ReviewUi, input: DataInputView, generators: readonly string[]): BindForm {
  return (
    ui.binds[input.stepId] ?? {
      source: input.source === 'SENSITIVE' ? 'FIXED' : input.source,
      variable: input.source === 'GENERATED' ? (input.key ?? '') : '',
      generator: input.generator ?? generators[0] ?? '',
      reference: input.reference ?? input.options[0]?.key ?? '',
      value: input.recordedValue ?? '',
    }
  );
}

const VERDICT_TONE: Record<string, string> = {
  VERIFIED_PASS: 'PASSED',
  VERIFIED_FAIL: 'FAILED',
  BLOCKED: 'BLOCKED',
  INCONCLUSIVE: 'INCONCLUSIVE',
  NOT_EXECUTED: 'UNKNOWN',
};
const OUTCOME_TONE: Record<string, string> = {
  MATCHED: 'PASSED',
  ASSERTION_MISMATCH: 'FAILED',
  AMBIGUOUS: 'INCOMPLETE',
  BLOCKED_BY_POLICY: 'BLOCKED',
  NOT_FOUND: 'FAILED',
  NOT_VERIFIED: 'UNKNOWN',
};
const FILE_TONE: Record<string, string> = {
  GENERATED: 'UNKNOWN',
  STATICALLY_VALIDATED: 'PASSED',
  NOT_VALIDATED: 'INCOMPLETE',
  EXECUTED: 'UNKNOWN',
  PASSED: 'PASSED',
  FAILED: 'FAILED',
  BLOCKED: 'BLOCKED',
  INCONCLUSIVE: 'INCONCLUSIVE',
};

function replayCard(state: DashboardState, ui: ReviewUi): string {
  const r = state.t.review;
  const replay = ui.replay;
  const running = replay?.status === 'RUNNING';
  const mayRun = can(state, 'RUN') && state.project?.state !== 'ARCHIVED';
  const now =
    replay && replay.status !== 'NONE'
      ? `<p class="row-line">${pill(replay.status === 'REPLAY_CONFIRMED' ? 'PASSED' : replay.status === 'RUNNING' ? 'RUNNING' : 'FAILED', r.replayStatuses[replay.status] ?? replay.status)}${
          running && replay.total
            ? ` <span class="mu">${esc(r.replayProgress(replay.executed ?? 0, replay.total))}</span>`
            : replay.status === 'REPLAY_FAILED' && replay.reason
              ? ` <span class="mu">${esc(replay.reason)}</span>`
              : ''
        }</p>${
          running && replay.total
            ? `<div class="prog" aria-hidden="true"><span style="width:${String(Math.round(((replay.executed ?? 0) / replay.total) * 100))}%"></span></div>`
            : ''
        }`
      : '';
  const last = replay?.last;
  const lastLine = last
    ? `<p class="mu">${esc(r.lastReplay(r.dryRun[last.status] ?? last.status, formatDate(last.at, state.t.locale)))}</p>${last.stale ? `<p class="note">${icon('alert')}<span>${esc(r.stale)}</span></p>` : ''}`
    : !now
      ? `<p class="mu">${esc(r.replayNone)}</p>`
      : '';
  return `<section class="card replay-card"><div class="card-h"><h2>${esc(r.replayTitle)}</h2>${
    mayRun
      ? `<button class="btn" data-action="review-replay" ${running || ui.busy ? 'disabled' : ''}>${icon('play')}<span>${esc(running ? r.replaying : r.replay)}</span></button>`
      : ''
  }</div>${now}${lastLine}<small class="mu">${esc(r.replayNote)}</small></section>`;
}

function stepRow(
  state: DashboardState,
  ui: ReviewUi,
  view: FlowStudioView,
  step: StudioStep,
  number: number | undefined,
  decide: boolean,
): string {
  const r = state.t.review;
  const disabled = ui.busy ? 'disabled' : '';
  const isCheck = step.kind === 'expect';
  const chosen = ui.selected.includes(step.id);
  const data = [
    ...step.produces.map(
      (key) => `<span class="tag prod">◆ ${esc(r.produces)} <code>${esc(key)}</code></span>`,
    ),
    ...step.consumes.map(
      (key) => `<span class="tag cons">◇ ${esc(r.consumes)} <code>${esc(key)}</code></span>`,
    ),
  ].join('');
  const violation = view.violations.find((entry) => entry.stepId === step.id);
  const outcome = step.replay
    ? pill(
        OUTCOME_TONE[step.replay.outcome] ?? 'UNKNOWN',
        r.outcomes[step.replay.outcome] ?? step.replay.outcome,
      )
    : '';
  const confirming = ui.confirmRemove === step.id;
  const actions = !decide
    ? ''
    : confirming
      ? `<span class="confirm" role="group"><small>${esc(r.removeConfirm)}</small><button class="btn small danger" data-action="review-remove-yes" data-step="${esc(step.id)}" ${disabled}>${esc(r.remove)}</button><button class="btn small ghost" data-action="review-remove-no">${esc(r.cancel)}</button></span>`
      : `<span class="row-acts"><button class="btn small ghost icon-only" data-action="review-move" data-step="${esc(step.id)}" data-direction="up" title="${esc(r.moveUp)}" aria-label="${esc(r.moveUp)}" ${disabled}>↑</button><button class="btn small ghost icon-only" data-action="review-move" data-step="${esc(step.id)}" data-direction="down" title="${esc(r.moveDown)}" aria-label="${esc(r.moveDown)}" ${disabled}>↓</button>${
          step.groupId
            ? `<button class="btn small ghost" data-action="review-detach" data-step="${esc(step.id)}" ${disabled}>${esc(r.detach)}</button>`
            : ''
        }${
          isCheck
            ? ''
            : `<button class="btn small ghost" data-action="review-remove" data-step="${esc(step.id)}" ${disabled}>${esc(r.remove)}</button>`
        }</span>`;
  return `<li class="rv-step ${isCheck ? 'is-check' : ''} ${chosen ? 'chosen' : ''}">${
    decide && !isCheck
      ? `<input type="checkbox" class="pickbox" data-review-pick="${esc(step.id)}" ${chosen ? 'checked' : ''} aria-label="${esc(r.choose(step.description))}">`
      : '<span class="pickbox" aria-hidden="true"></span>'
  }<span class="n" aria-hidden="true">${isCheck ? '✓' : String(number ?? '')}</span><span class="rv-main"><span class="rv-desc">${isCheck ? `<small class="mu">${esc(r.check)}</small> ` : ''}${esc(step.description)}${step.corrected ? ` ${pill('CONFIRMED', r.corrected)}` : ''}</span>${data ? `<span class="tags">${data}</span>` : ''}${violation ? `<small class="err">${esc(r.violation(violation.key))}</small>` : ''}${step.replay && step.replay.outcome !== 'MATCHED' && step.replay.reasons.length > 0 ? `<small class="mu">${esc(step.replay.reasons.map((reason) => phrase(state, reason)).join(' · '))}</small>` : ''}${targetLinks(state, ui, step, decide)}</span><span class="rv-side">${outcome}${actions}</span></li>`;
}

/** Corriger la cible (navigateur sur le serveur), redéfinir la ligne, restaurer l'original. */
function targetLinks(state: DashboardState, ui: ReviewUi, step: StudioStep, decide: boolean): string {
  if (!decide || !step.targeted || step.kind === 'expect') return '';
  const r = state.t.review;
  const disabled = ui.busy || ui.correction ? 'disabled' : '';
  const links = [
    can(state, 'RUN')
      ? `<button class="lnk" data-action="review-correct" data-step="${esc(step.id)}" ${disabled}>${esc(r.correctTarget)}</button>`
      : '',
    step.row
      ? `<button class="lnk" data-action="review-row-open" data-step="${esc(step.id)}" ${disabled}>${esc(r.editRow)}</button>`
      : '',
    step.corrected
      ? `<button class="lnk" data-action="review-restore" data-step="${esc(step.id)}" ${disabled}>${esc(r.restoreTarget)}</button>`
      : '',
  ].filter(Boolean);
  return links.length > 0
    ? `<span class="rv-links">${links.join('<span aria-hidden="true">·</span>')}</span>`
    : '';
}

/** La session de correction : rejeu jusqu'à l'étape, désignation, proposition, validation, reprise. */
function correctionCard(state: DashboardState, ui: ReviewUi): string {
  const view = ui.correction;
  if (!view) return '';
  const r = state.t.review;
  const disabled = ui.busy ? 'disabled' : '';
  const close = `<button class="btn ghost" data-action="review-correction-close" ${disabled}>${esc(r.close)}</button>`;
  const pickAgain = `<button class="btn" data-action="review-correction-pick" ${disabled}>${esc(r.pickAgain)}</button>`;
  let body = '';
  if (view.status === 'REPLAYING')
    body = `<p class="row-line"><span class="spin" aria-hidden="true"></span><span>${esc(r.correction.REPLAYING(view.executed, view.total))}</span></p><div class="form-acts start">${close}</div>`;
  else if (view.status === 'PICKING')
    body = `<p class="note">${icon('alert')}<span>${esc(r.correction.PICKING)}</span></p><div class="form-acts start">${close}</div>`;
  else if (view.status === 'HELD')
    body = `<p class="mu">${esc(r.correction.HELD)}</p><div class="form-acts start">${pickAgain}${close}</div>`;
  else if (view.status === 'PICKED' && view.proposal) {
    const proposal = view.proposal;
    const traits = [
      proposal.traits.role || proposal.traits.tag,
      proposal.traits.name ?? proposal.traits.label ?? proposal.traits.text,
      proposal.traits.testId ? `testId ${proposal.traits.testId}` : undefined,
      proposal.traits.section,
    ].filter((part): part is string => Boolean(part));
    const choice = ui.correctionChoice;
    const rows =
      proposal.rowOptions && proposal.rowOptions.length > 0
        ? `<fieldset class="rv-src col"><legend>${esc(r.rowWay)}</legend>${proposal.rowOptions
            .map((option, index) => {
              const checked =
                (choice.option ?? proposal.rowOptions?.[0]?.id) === option.id ||
                (!choice.option && index === 0);
              const text =
                option.id === 'bound'
                  ? r.rowOptions.bound(option.via ?? '')
                  : option.id === 'key'
                    ? r.rowOptions.key
                    : r.rowOptions.manual;
              const row = Object.entries(option.row)
                .map(([column, value]) => `${column} = ${value}`)
                .join(', ');
              return `<label class="chk"><input type="radio" name="rv-row-option" data-correction-option="${esc(option.id)}" ${checked ? 'checked' : ''}> ${esc(text)} <small class="mu">${esc(row)}${option.fixed ? ` · ${esc(r.fixedRow)}` : ''}</small></label>`;
            })
            .join('')}${
            choice.option === 'manual' &&
            proposal.rowCells &&
            proposal.variables &&
            proposal.variables.length > 0
              ? `<div class="fields"><label class="field">${esc(r.bindColumn)}<select data-correction-field="column">${proposal.rowCells
                  .map(
                    (cell) =>
                      `<option value="${esc(cell.column)}" ${choice.column === cell.column ? 'selected' : ''}>${esc(cell.column)} — ${esc(cell.value)}</option>`,
                  )
                  .join(
                    '',
                  )}</select></label><label class="field">${esc(r.bindKey)}<select data-correction-field="key">${proposal.variables
                  .map(
                    (key) =>
                      `<option value="${esc(key)}" ${choice.key === key ? 'selected' : ''}>${esc(key)}</option>`,
                  )
                  .join('')}</select></label></div>`
              : ''
          }</fieldset>`
        : '';
    body = `<dl class="kv"><dt>${esc(r.current)}</dt><dd><code>${esc(proposal.current)}</code></dd><dt>${esc(r.next)}</dt><dd><code>${esc(proposal.next)}</code></dd><dt>${esc(r.traitsTitle)}</dt><dd>${esc(traits.join(' · '))}</dd><dt>${esc(r.order)}</dt><dd>${esc(proposal.order.join(' → '))}</dd></dl>${
      proposal.ambiguous ? `<p class="note">${icon('alert')}<span>${esc(r.ambiguousTarget)}</span></p>` : ''
    }${rows}<div class="form-acts start"><button class="btn primary" data-action="review-correction-apply" ${disabled}>${esc(r.validate)}</button>${pickAgain}${close}</div>`;
  } else if (view.status === 'APPLIED' && view.applied)
    body = `<p>${pill('CONFIRMED', r.corrected)} ${esc(r.appliedText(view.applied.previous, view.applied.next))}</p><div class="form-acts start">${
      view.resumable && can(state, 'RUN')
        ? `<button class="btn primary" data-action="review-correction-resume" ${disabled}>${icon('play')}<span>${esc(r.resume)}</span></button>`
        : ''
    }${close}</div>`;
  else if (view.status === 'RESUMING')
    body = `<p class="row-line"><span class="spin" aria-hidden="true"></span><span>${esc(r.correction.RESUMING(view.executed, view.total))}</span></p>`;
  else if (view.status === 'RESUMED' && view.resume)
    body = `<p class="row-line">${pill(view.resume.status === 'PASSED' ? 'PASSED' : view.resume.status === 'FAILED' ? 'FAILED' : 'INCOMPLETE', r.resumeStatuses[view.resume.status] ?? view.resume.status)}<small class="mu">${esc(r.strategy(view.resume.strategy))}</small></p>${
      view.resume.reasons.length > 0
        ? `<small class="mu block">${esc(view.resume.reasons.map((reason) => phrase(state, reason)).join(' · '))}</small>`
        : ''
    }<div class="form-acts start">${close}</div>`;
  else if (view.status === 'UNREACHABLE' && view.stoppedAt)
    body = `<p class="err">${esc(r.unreachable(view.stoppedAt.index, view.stoppedAt.label, view.stoppedAt.reason))}</p><div class="form-acts start">${close}</div>`;
  else
    body = `${view.error ? `<p class="err">${esc(view.error)}</p>` : ''}<div class="form-acts start">${close}</div>`;
  return `<section class="card correction-card" aria-live="polite"><h2>${esc(r.correctionTitle(view.label))}</h2>${body}</section>`;
}

/** La ligne redéfinie colonne par colonne, à partir des cellules enregistrées (sans navigateur). */
function rowCard(state: DashboardState, ui: ReviewUi): string {
  const edit = ui.rowEdit;
  if (!edit) return '';
  const r = state.t.review;
  const disabled = ui.busy ? 'disabled' : '';
  const source = edit.source;
  const cancel = `<button type="button" class="btn ghost" data-action="review-row-cancel">${esc(r.cancel)}</button>`;
  if (!source)
    return `<section class="card"><h2>${esc(r.rowTitle)}</h2><p class="mu">${esc(state.t.loading)}</p></section>`;
  if (source.cells.length === 0)
    return `<section class="card"><h2>${esc(r.rowTitle)}</h2><p class="mu">${esc(r.rowNoCells)}</p><div class="form-acts start">${cancel}</div></section>`;
  const rows = source.cells
    .map((cell) => {
      const choice = edit.columns[cell.column] ?? {
        on: false,
        source: 'recorded',
        value: cell.value,
        key: '',
        contains: false,
      };
      const name = esc(cell.column);
      const detail =
        choice.source === 'value'
          ? `<input data-row-column="${name}" data-row-field="value" value="${esc(choice.value)}" maxlength="200" aria-label="${esc(r.rowSources.value ?? '')}">`
          : choice.source === 'variable'
            ? `<select data-row-column="${name}" data-row-field="key" aria-label="${esc(r.rowSources.variable ?? '')}">${source.variables
                .map(
                  (variable) =>
                    `<option value="${esc(variable.key)}" ${choice.key === variable.key ? 'selected' : ''}>${esc(variable.key)}</option>`,
                )
                .join('')}</select>`
            : choice.source === 'new-variable'
              ? `<input data-row-column="${name}" data-row-field="key" value="${esc(choice.key)}" placeholder="${esc(r.variable)}" maxlength="120" class="mono" aria-label="${esc(r.variable)}">`
              : '';
      return `<tr><td><label class="chk"><input type="checkbox" data-row-column="${name}" data-row-field="on" ${choice.on ? 'checked' : ''}> <b>${name}</b></label></td><td>${esc(cell.value)}</td><td><select data-row-column="${name}" data-row-field="source" ${choice.on ? '' : 'disabled'}>${(
        ['recorded', 'value', 'variable', 'new-variable'] as const
      )
        .filter((option) => option !== 'variable' || source.variables.length > 0)
        .map(
          (option) =>
            `<option value="${option}" ${choice.source === option ? 'selected' : ''}>${esc(r.rowSources[option] ?? option)}</option>`,
        )
        .join(
          '',
        )}</select> ${choice.on ? detail : ''}</td><td><label class="chk"><input type="checkbox" data-row-column="${name}" data-row-field="contains" ${choice.contains ? 'checked' : ''} ${choice.on ? '' : 'disabled'}> <small>${esc(r.rowMatch)}</small></label></td></tr>`;
    })
    .join('');
  const any = Object.values(edit.columns).some((choice) => choice.on);
  return `<section class="card wide"><h2>${esc(r.rowTitle)}</h2><p class="mu">${esc(r.rowNote)} <code>${esc(source.target)}</code></p><form class="col" data-action="review-row-save"><div class="tw"><table class="tbl"><thead><tr><th scope="col">${esc(r.rowColumn)}</th><th scope="col">${esc(r.rowRecorded)}</th><th scope="col">${esc(r.rowUse)}</th><th scope="col"></th></tr></thead><tbody>${rows}</tbody></table></div><div class="form-acts start"><button type="submit" class="btn primary" ${disabled || !any ? 'disabled' : ''}>${esc(r.rowSave)}</button>${cancel}</div></form></section>`;
}

/** Les intentions : déduites par l'analyse, confirmées ou corrigées par un humain. */
function intentsTab(state: DashboardState, ui: ReviewUi, decide: boolean): string {
  const r = state.t.review;
  const view = ui.intents;
  if (!view) return `<p class="mu">${esc(state.t.loading)}</p>`;
  if (view.rows.length === 0) return `<section class="card"><p class="mu">${esc(r.noIntent)}</p></section>`;
  const disabled = ui.busy ? 'disabled' : '';
  const items = view.rows
    .map((row) => {
      const editing = ui.intentEdit?.actionId === row.actionId;
      const actions = !decide
        ? ''
        : editing
          ? `<form class="col rv-intent" data-action="review-intent-save" data-intent-action="${esc(row.actionId)}"><div class="fields"><label class="field">${esc(r.newIntent)}<select data-intent-field="intent">${view.choices
              .map(
                (choice) =>
                  `<option value="${esc(choice)}" ${ui.intentEdit?.intent === choice ? 'selected' : ''}>${esc(choice)}</option>`,
              )
              .join(
                '',
              )}</select></label><label class="field">${esc(r.reasonField)}<input data-intent-field="reason" value="${esc(ui.intentEdit?.reason ?? '')}" maxlength="500" autocomplete="off"></label></div><div class="row-acts"><button type="submit" class="btn small primary" ${disabled}>${esc(r.save)}</button><button type="button" class="btn small ghost" data-action="review-intent-cancel">${esc(r.cancel)}</button></div></form>`
          : `<div class="row-acts"><button class="btn small" data-action="review-intent" data-type="CONFIRM" data-intent-action="${esc(row.actionId)}" ${disabled}>${esc(r.confirmIntent)}</button><button class="btn small ghost" data-action="review-intent-open" data-intent-action="${esc(row.actionId)}" ${disabled}>${esc(r.correctIntent)}</button>${
              row.source === 'HUMAN'
                ? `<button class="btn small ghost" data-action="review-intent" data-type="RESET" data-intent-action="${esc(row.actionId)}" ${disabled}>${esc(r.resetIntent)}</button>`
                : ''
            }</div>`;
      return `<li class="rv-assert"><div class="row-line"><b>${esc(row.label)}</b>${pill(row.source === 'HUMAN' ? 'CONFIRMED' : 'UNKNOWN', r.intentStatuses[row.status] ?? row.status)}<code>${esc(row.intent)}</code>${
        row.confidence !== undefined
          ? `<small class="mu">${esc(r.confidence(Math.round(row.confidence * 100)))}</small>`
          : ''
      }</div>${row.original ? `<small class="mu">${esc(r.wasIntent(row.original))}</small>` : ''}${row.reason ? `<small class="mu">${esc(r.why)} : ${esc(row.reason)}</small>` : ''}${actions}</li>`;
    })
    .join('');
  return `<section class="card"><p class="mu">${esc(r.intentsNote)}</p><ul class="plain rv-asserts">${items}</ul></section>`;
}

function groupHeader(state: DashboardState, ui: ReviewUi, group: GroupViewDto, decide: boolean): string {
  const r = state.t.review;
  const members = (ui.studio?.steps ?? []).filter((step) => group.stepIds.includes(step.id));
  const checks = members.filter((step) => step.kind === 'expect').length;
  const disabled = ui.busy ? 'disabled' : '';
  const runnable = group.runnableAlone.ok
    ? pill('PASSED', r.runnable)
    : `<span title="${esc(group.runnableAlone.missing.join(', '))}">${pill('INCOMPLETE', r.notRunnable)}</span>`;
  const renaming = ui.renaming?.id === group.id;
  const title = renaming
    ? `<form class="rv-rename" data-action="review-rename" data-group="${esc(group.id)}"><label class="sr" for="rv-rename-${esc(group.id)}">${esc(r.rename)}</label><input id="rv-rename-${esc(group.id)}" data-review="rename" value="${esc(ui.renaming?.name ?? '')}" maxlength="80" required><button type="submit" class="btn small" ${disabled}>${esc(r.save)}</button><button type="button" class="btn small ghost" data-action="review-rename-cancel">${esc(r.cancel)}</button></form>`
    : `<b>${esc(group.name)}</b>`;
  const actions =
    decide && !renaming
      ? `<span class="row-acts"><button class="btn small ghost" data-action="review-rename-open" data-group="${esc(group.id)}" ${disabled}>${esc(r.rename)}</button><button class="btn small ghost icon-only" data-action="review-move-group" data-group="${esc(group.id)}" data-direction="up" title="${esc(r.moveUp)}" aria-label="${esc(r.moveUp)}" ${disabled}>↑</button><button class="btn small ghost icon-only" data-action="review-move-group" data-group="${esc(group.id)}" data-direction="down" title="${esc(r.moveDown)}" aria-label="${esc(r.moveDown)}" ${disabled}>↓</button><button class="btn small ghost" data-action="review-delete-group" data-group="${esc(group.id)}" ${disabled}>${esc(r.deleteGroup)}</button>${
          can(state, 'PUBLISH')
            ? `<button class="btn small ghost" data-action="lib-group" data-group="${esc(group.id)}" ${disabled}>${esc(state.t.lib.groupToLibrary)}</button>`
            : ''
        }</span>`
      : '';
  const lib = state.lib;
  const toLibrary =
    lib.group?.id === group.id
      ? `<form class="rv-rename rv-lib" data-action="lib-group"><label class="sr" for="rv-lib-${esc(group.id)}">${esc(state.t.lib.blockName)}</label><input id="rv-lib-${esc(group.id)}" data-lib="group.name" value="${esc(lib.group.name)}" maxlength="80" required placeholder="${esc(state.t.lib.blockName)}"><button type="submit" class="btn small primary" ${lib.busy ? 'disabled' : ''}>${esc(state.t.lib.add)}</button><button type="button" class="btn small ghost" data-action="lib-group-cancel">${esc(r.cancel)}</button>${lib.error ? `<small class="err">${esc(lib.error)}</small>` : ''}</form>`
      : '';
  return `<div class="rv-group-h">${title}<small class="mu">${esc(r.stepsCount(members.length - checks))}${checks > 0 ? ` · ${esc(r.checksCount(checks))}` : ''} · <code>${esc(group.startAt)}</code></small>${runnable}${actions}${toLibrary}</div>`;
}

function flowTab(state: DashboardState, ui: ReviewUi, decide: boolean): string {
  const r = state.t.review;
  const view = ui.studio;
  if (!view) return `<p class="mu">${esc(state.t.loading)}</p>`;
  const disabled = ui.busy ? 'disabled' : '';
  const proposals = ui.groupProposals ?? [];
  const proposalCard =
    proposals.length > 0
      ? `<section class="card"><div class="card-h"><h2>${esc(r.proposalsTitle)}</h2>${decide ? `<button class="btn primary" data-action="review-accept-groups" ${disabled}>${esc(r.createAll(proposals.length))}</button>` : ''}</div><p class="mu">${esc(r.proposalsNote)}</p><ul class="plain tight">${proposals
          .map(
            (proposal) =>
              `<li><b>${esc(proposal.name)}</b> <span class="mu">· ${esc(r.proposalRange(proposal.from, proposal.to))}</span></li>`,
          )
          .join('')}</ul></section>`
      : '';
  const checks = ui.checks ?? [];
  const checkCard =
    checks.length > 0
      ? `<section class="card"><h2>${esc(r.checksTitle)}</h2><ul class="plain rv-checks">${checks
          .map(
            (check) =>
              `<li><span>${esc(r.checkText(check.key, check.groupName))}</span>${decide ? `<button class="btn small" data-action="review-add-check" data-group="${esc(check.groupId)}" data-key="${esc(check.key)}" ${disabled}>${esc(r.addCheck)}</button>` : ''}</li>`,
          )
          .join('')}</ul></section>`
      : '';
  // Les étapes dans l'ordre du flow ; un groupe s'annonce à sa première étape.
  const groups = new Map(view.groups.map((group) => [group.id, group]));
  let number = 0;
  let current: string | undefined | null = null;
  const blocks: string[] = [];
  let items: string[] = [];
  const flush = (): void => {
    if (items.length === 0) return;
    const group = current ? groups.get(current) : undefined;
    blocks.push(
      `<div class="rv-group ${group ? '' : 'loose'}">${group ? groupHeader(state, ui, group, decide) : `<div class="rv-group-h"><b class="mu">${esc(r.noGroup)}</b></div>`}<ol class="plain rv-steps">${items.join('')}</ol></div>`,
    );
    items = [];
  };
  for (const step of view.steps) {
    const groupId = step.groupId ?? undefined;
    if (groupId !== current) {
      flush();
      current = groupId;
    }
    if (step.kind !== 'expect') number += 1;
    items.push(stepRow(state, ui, view, step, step.kind === 'expect' ? undefined : number, decide));
  }
  flush();
  const groupOptions = view.groups
    .map((group) => `<option value="${esc(group.id)}">${esc(group.name)}</option>`)
    .join('');
  const selection =
    decide && ui.selected.length > 0
      ? `<div class="rv-selbar" role="region" aria-label="${esc(r.selected(ui.selected.length))}"><b>${esc(r.selected(ui.selected.length))}</b><form class="rv-new" data-action="review-create-group"><label class="sr" for="rv-new-group">${esc(r.groupName)}</label><input id="rv-new-group" data-review="newGroup" value="${esc(ui.newGroup)}" placeholder="${esc(r.groupName)}" maxlength="80" required><button type="submit" class="btn small primary" ${disabled}>${esc(r.createGroup)}</button></form>${
          groupOptions
            ? `<label class="sr" for="rv-assign">${esc(r.addTo)}</label><select id="rv-assign" data-action="review-assign" ${disabled}><option value="">${esc(r.addTo)}</option>${groupOptions}</select>`
            : ''
        }<button class="btn small ghost" data-action="review-detach-selected" ${disabled}>${esc(r.detach)}</button><button class="btn small ghost" data-action="review-clear">${esc(r.clear)}</button></div>`
      : '';
  return `${correctionCard(state, ui)}${rowCard(state, ui)}${proposalCard}${checkCard}<section class="card wide rv-flow">${blocks.join('')}${selection}</section>`;
}

function proposalItem(
  state: DashboardState,
  ui: ReviewUi,
  proposal: AssertionProposalView,
  decide: boolean,
): string {
  const r = state.t.review;
  const disabled = ui.busy ? 'disabled' : '';
  const editing = ui.editing?.id === proposal.id;
  const decideButtons = !decide
    ? ''
    : editing
      ? `<form class="col rv-modify" data-action="review-modify" data-assertion="${esc(proposal.id)}"><label class="field">${esc(r.description)}<textarea data-review="modify" rows="2" maxlength="500" required>${esc(ui.editing?.description ?? '')}</textarea></label><div class="row-acts"><button type="submit" class="btn small primary" ${disabled}>${esc(r.save)}</button><button type="button" class="btn small ghost" data-action="review-modify-cancel">${esc(r.cancel)}</button></div></form>`
      : `<div class="row-acts">${(['ACCEPT', 'REJECT', 'DISABLE'] as const)
          .map(
            (decision) =>
              `<button class="btn small ${decision === 'ACCEPT' ? '' : 'ghost'}" data-action="review-decide" data-decision="${decision}" data-assertion="${esc(proposal.id)}" ${disabled}>${esc(decision === 'ACCEPT' ? r.accept : decision === 'REJECT' ? r.reject : r.disable)}</button>`,
          )
          .join(
            '',
          )}<button class="btn small ghost" data-action="review-modify-open" data-assertion="${esc(proposal.id)}" ${disabled}>${esc(r.modify)}</button>${
          proposal.status !== 'PROPOSED'
            ? `<button class="btn small ghost" data-action="review-decide" data-decision="RESET" data-assertion="${esc(proposal.id)}" ${disabled}>${esc(r.reset)}</button>`
            : ''
        }</div>`;
  return `<li class="rv-assert"><div class="row-line">${pill(proposal.status === 'PROPOSED' ? 'PROPOSED' : proposal.status === 'REJECTED' || proposal.status === 'DISABLED' ? 'REJECTED' : 'CONFIRMED', r.statuses[proposal.status] ?? proposal.status)}${pill(VERDICT_TONE[proposal.verdict.status] ?? 'UNKNOWN', r.verdicts[proposal.verdict.status] ?? proposal.verdict.status)}<small class="mu">${esc(r.methods[proposal.verificationMethod] ?? proposal.verificationMethod)} · ${esc(r.confidence(Math.round(proposal.confidence * 100)))} · ${esc(proposal.inFlow ? r.inFlow : r.notInFlow)}</small></div><p class="rv-what">${esc(phrase(state, proposal.description))}</p><small class="mu">${esc(r.why)} : ${esc(phrase(state, proposal.why))}</small>${
    proposal.verdict.status !== 'NOT_EXECUTED' &&
    proposal.verdict.status !== 'VERIFIED_PASS' &&
    proposal.verdict.reasons.length > 0
      ? `<small class="mu block">${esc(proposal.verdict.reasons.map((reason) => phrase(state, reason)).join(' · '))}</small>`
      : ''
  }${decideButtons}</li>`;
}

function assertionsTab(state: DashboardState, ui: ReviewUi, decide: boolean): string {
  const r = state.t.review;
  const list = ui.assertions;
  if (!list) return `<p class="mu">${esc(state.t.loading)}</p>`;
  if (list.length === 0) return `<section class="card"><p class="mu">${esc(r.noAssertion)}</p></section>`;
  const disabled = ui.busy ? 'disabled' : '';
  const buckets = assertionBuckets(list);
  const section = (
    title: string,
    items: AssertionProposalView[],
    extra: string,
    note?: string,
    folded = false,
  ): string => {
    if (items.length === 0) return '';
    const body = `<ul class="plain rv-asserts">${items.map((proposal) => proposalItem(state, ui, proposal, decide)).join('')}</ul>`;
    return folded
      ? `<section class="card"><details><summary><b>${esc(title)}</b> · ${String(items.length)}</summary>${note ? `<p class="mu">${esc(note)}</p>` : ''}${extra}${body}</details></section>`
      : `<section class="card"><div class="card-h"><h2>${esc(title)} · ${String(items.length)}</h2>${extra}</div>${note ? `<p class="mu">${esc(note)}</p>` : ''}${body}</section>`;
  };
  return [
    section(
      r.recommended,
      buckets.recommended,
      decide
        ? `<button class="btn primary" data-action="review-decide-all" data-decision="ACCEPT" data-bucket="recommended" ${disabled}>${esc(r.acceptAll(buckets.recommended.length))}</button>`
        : '',
      r.recommendedNote,
    ),
    section(r.toDecide, buckets.toDecide, ''),
    section(
      r.weak,
      buckets.weak,
      decide
        ? `<div class="row-acts"><button class="btn small ghost" data-action="review-decide-all" data-decision="REJECT" data-bucket="weak" ${disabled}>${esc(r.rejectAll)}</button></div>`
        : '',
      r.weakNote,
      true,
    ),
    section(r.decided, buckets.decided, ''),
  ].join('');
}

function dataTab(state: DashboardState, ui: ReviewUi, decide: boolean): string {
  const r = state.t.review;
  const data = ui.data;
  if (!data) return `<p class="mu">${esc(state.t.loading)}</p>`;
  const disabled = ui.busy ? 'disabled' : '';
  const missing =
    data.missing.length > 0
      ? `<section class="card warn-card" role="alert"><h2>${esc(r.missingTitle)}</h2><ul class="plain tight">${data.missing
          .map((entry) => `<li><code>${esc(entry.key)}</code> — ${esc(entry.message)}</li>`)
          .join('')}</ul></section>`
      : '';
  const inputs =
    data.inputs.length === 0
      ? `<p class="mu">${esc(r.noInput)}</p>`
      : `<ul class="plain rv-inputs">${data.inputs
          .map((input) => {
            const current = `${pill(input.source === 'SENSITIVE' ? 'BLOCKED' : 'UNKNOWN', r.sources[input.source] ?? input.source)}${input.key ? ` <code>${esc(input.key)}</code>` : ''} <small class="mu">${esc(input.manual ? r.manual : r.auto)}</small>`;
            if (input.source === 'SENSITIVE' || !decide)
              return `<li><div class="row-line"><b>${String(input.position)}. ${esc(input.label)}</b>${current}</div>${input.source === 'SENSITIVE' ? `<small class="mu">${esc(r.secretNote)}</small>` : ''}</li>`;
            const form = bindFormOf(ui, input, data.generators);
            const radio = (source: BindForm['source'], off = false): string =>
              `<label class="chk"><input type="radio" name="rv-src-${esc(input.stepId)}" data-bind-step="${esc(input.stepId)}" data-bind-field="source" value="${source}" ${form.source === source ? 'checked' : ''} ${off ? 'disabled' : ''}> ${esc(r.sources[source] ?? source)}</label>`;
            const detail =
              form.source === 'FIXED'
                ? `<label class="field">${esc(r.value)}<input data-bind-step="${esc(input.stepId)}" data-bind-field="value" value="${esc(form.value)}" maxlength="500" autocomplete="off"></label>`
                : form.source === 'GENERATED'
                  ? `<div class="fields"><label class="field">${esc(r.variable)}<input data-bind-step="${esc(input.stepId)}" data-bind-field="variable" value="${esc(form.variable)}" maxlength="120" class="mono" autocomplete="off"></label><label class="field">${esc(r.generator)}<select data-bind-step="${esc(input.stepId)}" data-bind-field="generator">${data.generators
                      .map(
                        (generator) =>
                          `<option value="${esc(generator)}" ${form.generator === generator ? 'selected' : ''}>${esc(generator)}</option>`,
                      )
                      .join('')}</select></label></div>`
                  : input.options.length === 0
                    ? `<p class="mu">${esc(r.noEarlier)}</p>`
                    : `<label class="field">${esc(r.reference)}<select data-bind-step="${esc(input.stepId)}" data-bind-field="reference">${input.options
                        .map(
                          (option) =>
                            `<option value="${esc(option.key)}" ${form.reference === option.key ? 'selected' : ''}>${esc(option.key)} — ${String(option.position)}. ${esc(option.label)}</option>`,
                        )
                        .join('')}</select></label>`;
            return `<li><div class="row-line"><b>${String(input.position)}. ${esc(input.label)}</b>${current}</div><form class="col rv-bind" data-action="review-bind" data-step="${esc(input.stepId)}"><fieldset class="rv-src"><legend class="sr">${esc(input.label)}</legend>${radio('FIXED')}${radio('GENERATED')}${radio('REFERENCE', input.options.length === 0)}</fieldset>${detail}<div class="row-acts"><button type="submit" class="btn small" ${disabled}>${esc(r.saveChoice)}</button></div></form></li>`;
          })
          .join('')}</ul>`;
  const lineage =
    data.variables.length === 0
      ? ''
      : `<section class="card"><h2>${esc(r.lineage)}</h2><ul class="plain tight">${data.variables
          .map(
            (variable) =>
              `<li><code>${esc(variable.key)}</code> <small class="mu">${esc(variable.strategy)}${variable.generator ? ` · ${esc(variable.generator)}` : ''}</small>${variable.producedBy ? ` · ${esc(r.producedBy)} ${String(variable.producedBy.position)}. ${esc(variable.producedBy.label)}` : ''}${variable.usedBy.length > 0 ? ` · ${esc(r.usedBy)} ${variable.usedBy.map((use) => `${String(use.position)}. ${esc(use.label)}`).join(', ')}` : ''}</li>`,
          )
          .join('')}</ul></section>`;
  return `${missing}<section class="card">${inputs}</section>${lineage}`;
}

function testsTab(state: DashboardState, ui: ReviewUi, decide: boolean): string {
  const r = state.t.review;
  const disabled = ui.busy ? 'disabled' : '';
  const groups = ui.studio?.groups ?? [];
  const form = decide
    ? `<section class="card"><form class="col rv-gen" data-action="review-generate"><fieldset><legend>${esc(r.formatsLabel)}</legend><div class="chips-row">${GENERATION_FORMATS.map(
        (format) =>
          `<label class="chk"><input type="checkbox" data-review-format="${format}" ${ui.formats.includes(format) ? 'checked' : ''}> ${esc(r.formats[format] ?? format)}</label>`,
      ).join('')}</div></fieldset>${
        groups.length > 0
          ? `<fieldset><legend>${esc(r.groupsLabel)}</legend><div class="chips-row">${groups
              .map(
                (group) =>
                  `<label class="chk"><input type="checkbox" data-review-gen-group="${esc(group.id)}" ${ui.genGroups.includes(group.id) ? 'checked' : ''}> ${esc(group.name)}</label>`,
              )
              .join('')}</div></fieldset>`
          : ''
      }<p class="note">${icon('alert')}<span>${esc(r.generationNote)}</span></p><div class="form-acts start"><button type="submit" class="btn primary" ${disabled || ui.formats.length === 0 ? 'disabled' : ''}>${esc(ui.busy === 'generate' ? r.generating : r.generate)}</button></div></form></section>`
    : '';
  const result = ui.generation;
  const files = result
    ? `<section class="card wide"><h2>${esc(r.filesTitle)}</h2>${result.warnings.length > 0 ? `<ul class="plain tight warn-list">${result.warnings.map((warning) => `<li>${esc(warning)}</li>`).join('')}</ul>` : ''}<ul class="plain rv-files">${result.files
        .map(
          (file) =>
            `<li><div class="row-line">${pill(FILE_TONE[file.status] ?? 'UNKNOWN', r.fileStatuses[file.status] ?? file.status)}<b>${esc(r.formats[file.format] ?? file.format)}</b><code>${esc(file.path)}</code></div>${
              file.validation
                ? `<small class="${file.validation.ok ? 'mu' : 'err'} block">${esc(phrase(state, file.validation.method))}${file.validation.messages.length > 0 ? ` — ${esc(file.validation.messages.map((message) => phrase(state, message)).join(' · '))}` : ''}</small>`
                : ''
            }${
              file.assertions.length > 0
                ? `<ul class="plain tight">${file.assertions.map((assertion) => `<li><small>${esc(assertion.description)} <span class="mu">(${esc(r.support[assertion.support] ?? assertion.support)})</span></small></li>`).join('')}</ul>`
                : ''
            }${file.limits.length > 0 ? `<small class="mu block">${esc(r.limits)} : ${esc(file.limits.join(' · '))}</small>` : ''}<details><summary>${esc(r.showContent)}</summary><pre class="code">${esc(file.content)}</pre></details></li>`,
        )
        .join('')}</ul></section>`
    : '';
  return `${form}${files}`;
}

export function reviewView(state: DashboardState): string {
  const t = state.t;
  const r = t.review;
  const ui = state.review;
  const route = state.route;
  const name = route.view === 'recording' ? route.name : (ui?.name ?? '');
  const tab: ReviewTab = route.view === 'recording' ? (route.tab ?? 'flow') : 'flow';
  const back: [string, string] = ['recordings', r.back];
  if (!ui || !state.project)
    return `${header(`${esc(r.title)} · <code>${esc(name)}</code>`, { back })}<section class="msg"><span class="spin" aria-hidden="true"></span><p class="mu">${esc(t.loading)}</p></section>`;
  const decide = can(state, 'DECIDE') && state.project.state !== 'ARCHIVED';
  const view = ui.studio;
  const actions = view ? view.steps.filter((step) => step.kind !== 'expect').length : 0;
  const pending = (ui.assertions ?? []).filter((proposal) => proposal.status === 'PROPOSED').length;
  const label: Record<ReviewTab, string> = {
    flow: r.tabs.flow(actions, view?.groups.length ?? 0),
    assertions: r.tabs.assertions(pending),
    data: r.tabs.data(ui.data?.inputs.length ?? 0),
    intents: r.intentsTab(ui.intents?.rows.length ?? 0),
    tests: r.tabs.tests,
    publish: t.pub.tab,
  };
  const tabs = `<div class="tabs" role="tablist" aria-label="${esc(r.title)}">${REVIEW_TABS.map(
    (key) =>
      `<button role="tab" data-action="review-tab" data-tab="${key}" aria-selected="${key === tab ? 'true' : 'false'}">${esc(label[key])}</button>`,
  ).join('')}</div>`;
  const body =
    tab === 'flow'
      ? flowTab(state, ui, decide)
      : tab === 'assertions'
        ? assertionsTab(state, ui, decide)
        : tab === 'data'
          ? dataTab(state, ui, decide)
          : tab === 'intents'
            ? intentsTab(state, ui, decide)
            : tab === 'publish'
              ? publishTab(state)
              : testsTab(state, ui, decide);
  const messages = `${state.lib.notice ? `<p class="notice ok" role="status">${icon('check')}<span>${esc(state.lib.notice)}</span></p>` : ''}${ui.error ? `<p class="err" role="alert">${esc(ui.error)}</p>` : ''}${
    ui.warnings && ui.warnings.length > 0
      ? `<div class="notice" role="status"><b>${esc(r.warnings)}</b><ul class="plain tight">${ui.warnings.map((warning) => `<li>${esc(warning)}</li>`).join('')}</ul></div>`
      : ''
  }`;
  return `${header(`${esc(r.title)} · <code>${esc(name)}</code>`, {
    back,
    sub: esc(r.sub),
    actions: `<a class="btn" href="${esc(studioLink(state, name))}" target="_blank" rel="noopener">${esc(r.openStudio)}</a>`,
  })}${reviewFacts(state)}${tab === 'publish' ? '' : replayCard(state, ui)}${tabs}${messages}${body}`;
}
