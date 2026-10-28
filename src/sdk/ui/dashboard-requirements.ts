import type {
  CanonicalEntity,
  ExtractedItem,
  ImportBatch,
  ImportProfile,
  ImportSummary,
  MatrixLinkCell,
  MatrixRow,
  Ratio,
  RequirementConnectorView,
  RequirementsIndicators,
  RequirementsView,
  TrendsView,
} from '../core/contracts.js';
import type { DashboardState } from './dashboard-view.js';
import { formatDate, header, icon, pill } from './dashboard-parts.js';
import { esc } from './view.js';

/**
 * LES ÉCRANS DES EXIGENCES : sources et imports, validation d'un import, référentiel, matrice de
 * traçabilité, indicateurs, tendances. Des fonctions pures, de l'état vers le HTML échappé. Rien
 * n'est décidé ici : chaque bouton appelle le SDK, et le serveur vérifie tout (projet archivé, lecture
 * partielle, fusion obligatoire d'un conflit). Un chiffre dit toujours son numérateur et son
 * dénominateur ; ce qui demande la corrélation (phase 5) est dit indisponible.
 */

/** Le formulaire d'import, tel que saisi. Le fichier choisi reste dans le contrôleur. */
export interface ImportForm {
  source: 'CONFLUENCE' | 'FILE';
  baseUrl: string;
  page: string;
  variant: '' | 'cloud' | 'datacenter';
  userEnv: string;
  tokenEnv: string;
  profile: string;
  fileName: string;
}

export interface LinkForm {
  type: string;
  targetKind: string;
  targetId: string;
  justification: string;
}

export interface RequirementsUi {
  connectors?: RequirementConnectorView[];
  profiles?: ImportProfile[];
  imports?: ImportSummary[];
  form: ImportForm;
  busy?: boolean;
  error?: string;
  batch?: ImportBatch;
  /** Le candidat dont la décision est en cours d'envoi. */
  deciding?: string;
  repository?: RequirementsView;
  matrix?: MatrixRow[];
  kind: string;
  source: string;
  linkForm?: LinkForm;
  indicators?: RequirementsIndicators;
  trends?: TrendsView;
  weeks: number;
}

export const emptyImportForm = (): ImportForm => ({
  source: 'FILE',
  baseUrl: '',
  page: '',
  variant: '',
  userEnv: '',
  tokenEnv: '',
  profile: '',
  fileName: '',
});

export const emptyLinkForm = (): LinkForm => ({
  type: 'TESTED_BY',
  targetKind: 'TEST',
  targetId: '',
  justification: '',
});

export const TREND_WEEKS = [8, 12, 26] as const;
const KINDS = ['REQUIREMENT', 'BUSINESS_RULE', 'ACCEPTANCE_CRITERION'] as const;
const SOURCE_KINDS = ['CONFLUENCE', 'WORD', 'EXCEL', 'PDF'] as const;
const ADDABLE_LINKS = [
  'TESTED_BY',
  'VERIFIED_BY',
  'IMPLEMENTED_BY',
  'OBSERVED_IN',
  'DEPENDS_ON',
  'DERIVED_FROM',
];
const TARGET_KINDS = ['TEST', 'CODE', 'ASSERTION', 'EVIDENCE', 'OPERATION'];

/** Le connecteur d'un fichier, d'après son extension. */
export function connectorOfFile(name: string): 'WORD' | 'EXCEL' | 'PDF' | undefined {
  const lower = name.toLowerCase();
  if (lower.endsWith('.docx')) return 'WORD';
  if (lower.endsWith('.xlsx')) return 'EXCEL';
  if (lower.endsWith('.pdf')) return 'PDF';
  return undefined;
}

/** Le nom d'une source (CONFLUENCE → Confluence) : un nom propre, le même dans toutes les langues. */
export const sourceName = (kind: string): string =>
  kind === 'PDF' ? 'PDF' : kind.charAt(0) + kind.slice(1).toLowerCase();

/** L'identifiant lisible d'un élément du référentiel (son identifiant externe), sinon l'identifiant tel quel. */
function labelOf(state: DashboardState, id: string): string {
  return state.req.repository?.entities.find((entity) => entity.id === id)?.externalId ?? id;
}

const percent = (ratio: Ratio): string =>
  ratio.value === undefined ? '—' : `${String(Math.round(ratio.value * 100))} %`;

const field = (name: string, label: string, value: string, extra = ''): string =>
  `<label class="field">${esc(label)}<input data-req="${name}" value="${esc(value)}" ${extra}></label>`;

function needsProject(state: DashboardState, title: string): string | undefined {
  if (state.project) return undefined;
  return `${header(esc(title))}<section class="msg"><span class="spin" aria-hidden="true"></span><p class="mu">${esc(state.t.loading)}</p></section>`;
}

// ── Sources et imports ─────────────────────────────────────────────────────────────────────────

export function sourcesView(state: DashboardState): string {
  const t = state.t;
  const r = t.req;
  const waiting = needsProject(state, r.sourcesTitle);
  if (waiting) return waiting;
  const ui = state.req;
  const archived = state.project?.state === 'ARCHIVED';
  const connectors = (ui.connectors ?? [])
    .map((connector) => {
      const reads = Object.entries(connector.capabilities)
        .filter(([key, value]) => value && r.capability[key])
        .map(([key]) => r.capability[key] ?? key)
        .join(', ');
      return `<article class="card conn"><div class="card-h"><h3>${esc(connector.label)}</h3><span class="mu">${esc(r.maxSize(connector.maxBytes))}</span></div><p class="mu">${esc(connector.formats.join(' · '))}${reads ? `<span class="block">${esc(r.reads)} : ${esc(reads)}</span>` : ''}</p>${
        connector.limits.length > 0
          ? `<details><summary>${esc(r.limitsTitle)}</summary><ul class="plain tight">${connector.limits.map((limit) => `<li class="mu">${esc(limit)}</li>`).join('')}</ul></details>`
          : ''
      }</article>`;
    })
    .join('');
  const form = ui.form;
  const profiles = (ui.profiles ?? []).filter((profile) =>
    form.source === 'CONFLUENCE'
      ? profile.connector === 'CONFLUENCE'
      : profile.connector === (connectorOfFile(form.fileName) ?? profile.connector),
  );
  const profileSelect = `<label class="field">${esc(r.profile)}<select data-req="profile"><option value="">${esc(r.profileNone)}</option>${profiles
    .map(
      (profile) =>
        `<option value="${esc(profile.name)}" ${profile.name === form.profile ? 'selected' : ''}>${esc(profile.name)} · ${esc(profile.connector)}</option>`,
    )
    .join('')}</select></label>`;
  const specific =
    form.source === 'CONFLUENCE'
      ? `<div class="fields">${field('baseUrl', r.baseUrl, form.baseUrl, 'inputmode="url" class="mono" placeholder="https://"')}${field('page', r.page, form.page, 'class="mono"')}</div><small class="mu">${esc(r.pageHint)}</small>
<div class="fields"><label class="field">${esc(r.variant)}<select data-req="variant"><option value="" ${form.variant === '' ? 'selected' : ''}>${esc(r.variantAuto)}</option><option value="cloud" ${form.variant === 'cloud' ? 'selected' : ''}>${esc(r.variantCloud)}</option><option value="datacenter" ${form.variant === 'datacenter' ? 'selected' : ''}>${esc(r.variantDc)}</option></select></label>${field('tokenEnv', r.tokenEnv, form.tokenEnv, 'class="mono" autocomplete="off" spellcheck="false" placeholder="QA_…"')}</div>
${field('userEnv', r.userEnv, form.userEnv, 'class="mono" autocomplete="off" spellcheck="false" placeholder="QA_…"')}
<p class="note">${icon('alert')}<span>${esc(r.secretNote)}</span></p>`
      : `<label class="field">${esc(r.file)}<input type="file" data-req="file" accept=".docx,.xlsx,.pdf"></label>${form.fileName ? `<p class="mu"><code>${esc(form.fileName)}</code></p>` : ''}<small class="mu">${esc(r.fileNote)}</small>`;
  const importCard = archived
    ? ''
    : `<section class="card"><h2>${esc(r.newImport)}</h2><form class="col req-form" data-action="import-form">
<label class="field">${esc(r.sourceKind)}<select data-req="source"><option value="FILE" ${form.source === 'FILE' ? 'selected' : ''}>${esc(r.fileOption)}</option><option value="CONFLUENCE" ${form.source === 'CONFLUENCE' ? 'selected' : ''}>${esc(r.confluenceOption)}</option></select></label>
${specific}${profileSelect}
<div class="form-acts start"><button type="button" class="btn primary" data-action="import" ${ui.busy ? 'disabled' : ''}>${icon('sources')}<span>${esc(ui.busy ? r.importing : r.importAction)}</span></button></div>
${ui.error ? `<p class="err" role="alert">${esc(ui.error)}</p>` : ''}</form></section>`;
  const imports = ui.imports ?? [];
  const history = `<section class="card wide"><h2>${esc(r.importsTitle)}</h2>${
    imports.length === 0
      ? `<p class="mu">${esc(r.noImport)}</p>`
      : `<div class="tw"><table class="tbl"><thead><tr><th scope="col">${esc(r.colSource)}</th><th scope="col">${esc(r.colStatus)}</th><th scope="col">${esc(r.colCandidates)}</th><th scope="col">${esc(r.colReported)}</th><th scope="col">${esc(r.colDate)}</th></tr></thead><tbody>${imports
          .map(
            (batch) =>
              `<tr><td><button class="lnk" data-action="open-import" data-batch="${esc(batch.id)}">${esc(sourceName(batch.connector))} · ${esc(batch.source.title || r.untitled)}</button></td><td>${pill(batch.status, r.statuses[batch.status] ?? batch.status)}</td><td>${esc(r.candidatesLine(batch.candidates, batch.toDecide, batch.published))}</td><td class="mu">${esc(batch.issues.first ?? '—')}</td><td>${esc(formatDate(batch.createdAt, t.locale))}</td></tr>`,
          )
          .join('')}</tbody></table></div>`
  }</section>`;
  const profileList = `<section class="card"><h2>${esc(r.profilesTitle)}</h2>${
    (ui.profiles ?? []).length === 0
      ? `<p class="mu">${esc(r.noProfile)}</p>`
      : `<ul class="plain">${(ui.profiles ?? [])
          .map(
            (profile) =>
              `<li><b>${esc(profile.name)}</b> <span class="mu">· ${esc(profile.connector)}${Object.keys(profile.options).length > 0 ? ` · ${esc(Object.keys(profile.options).join(', '))}` : ''}</span></li>`,
          )
          .join('')}</ul>`
  }</section>`;
  return `${header(esc(r.sourcesTitle), { sub: esc(r.sourcesSub) })}<div class="conn-grid">${connectors}</div><div class="split">${importCard ? `<div class="col">${importCard}</div>` : ''}<aside class="col narrow">${profileList}</aside></div>${history}`;
}

// ── Validation d'un import ─────────────────────────────────────────────────────────────────────

const DUPLICATE_TONE: Record<string, string> = {
  NEW: 'UNKNOWN',
  UNCHANGED: 'SKIPPED',
  SOURCE_CHANGED: 'INCOMPLETE',
  SAME_ID_OTHER_SOURCE: 'FAILED',
  SIMILAR: 'INCOMPLETE',
};

function candidate(state: DashboardState, item: ExtractedItem, batch: ImportBatch): string {
  const r = state.t.req;
  const busy = state.req.deciding === item.id;
  const kind = `<span class="tag-k">${esc(r.kinds[item.kind] ?? item.kind)}</span>`;
  const id = item.externalId ? `<code>${esc(item.externalId)}</code>` : '';
  const duplicate = pill(
    DUPLICATE_TONE[item.duplicate.status] ?? 'UNKNOWN',
    r.duplicates[item.duplicate.status] ?? item.duplicate.status,
  );
  const similarity =
    item.duplicate.similarity === undefined
      ? ''
      : ` <small class="mu">${esc(r.similarity(item.duplicate.similarity))}</small>`;
  const parent = item.parentExternalId
    ? `<small class="mu block">${esc(r.parentProposed(item.parentExternalId))}</small>`
    : '';
  const where = r.location(item.source.location);
  let actions = '';
  if (item.published)
    actions = `<p class="ok-t">${esc(r.publishedAs(item.published.entityId, item.published.version))}</p>`;
  else if (item.duplicate.status === 'UNCHANGED') actions = '';
  else {
    const decided = item.decision
      ? `<p class="mu">${esc(r.decisionShown(r.decisions[item.decision.action] ?? item.decision.action))}</p>`
      : '';
    const disabled = busy || batch.status === 'FAILED' ? 'disabled' : '';
    const merge =
      (item.duplicate.status === 'SIMILAR' || item.duplicate.status === 'SAME_ID_OTHER_SOURCE') &&
      item.duplicate.entityId
        ? `<button class="btn" data-action="decide" data-item="${esc(item.id)}" data-decision="MERGE" data-into="${esc(item.duplicate.entityId)}" ${disabled}>${esc(r.merge(labelOf(state, item.duplicate.entityId)))}</button>`
        : '';
    const accept =
      item.duplicate.status === 'SAME_ID_OTHER_SOURCE'
        ? ''
        : item.kind === 'UNCLASSIFIED'
          ? `<label class="inline">${esc(r.acceptAs)} <select data-kind-for="${esc(item.id)}">${KINDS.map((option) => `<option value="${option}">${esc(r.kinds[option] ?? option)}</option>`).join('')}</select></label><button class="btn primary" data-action="decide" data-item="${esc(item.id)}" data-decision="ACCEPT" ${disabled}>${esc(r.accept)}</button>`
          : `<button class="btn primary" data-action="decide" data-item="${esc(item.id)}" data-decision="ACCEPT" ${item.decision?.action === 'ACCEPT' ? 'aria-pressed="true"' : ''} ${disabled}>${esc(r.accept)}</button>`;
    actions = `${decided}<div class="row-acts">${accept}${merge}<button class="btn ghost" data-action="decide" data-item="${esc(item.id)}" data-decision="REJECT" ${item.decision?.action === 'REJECT' ? 'aria-pressed="true"' : ''} ${disabled}>${esc(r.reject)}</button></div>`;
  }
  const state_ = item.decision ? `data-decided="${esc(item.decision.action)}"` : '';
  return `<article class="cand" ${state_}><div class="cand-h">${kind}${id}<span class="mu">${esc(r.confidence(item.confidence))}</span>${duplicate}${similarity}</div><b class="cand-t">${esc(item.title)}</b>${item.description && item.description !== item.title ? `<p class="mu">${esc(item.description)}</p>` : ''}${parent}<small class="mu block">${esc(r.why)} : ${esc(item.reasons.join(' ; ') || '—')}${where ? ` · ${esc(where)}` : ''}</small>${actions}</article>`;
}

export function importView(state: DashboardState): string {
  const t = state.t;
  const r = t.req;
  const back: [string, string] = ['sources', r.sourcesTitle];
  const batch = state.req.batch;
  if (!batch || !state.project)
    return `${header(esc(r.validateTitle), { back })}<section class="msg"><span class="spin" aria-hidden="true"></span><p class="mu">${esc(t.loading)}</p></section>`;
  const candidates = batch.items.filter((item) => item.kind !== 'INFORMATION');
  const open = candidates.filter((item) => !item.published && item.duplicate.status !== 'UNCHANGED');
  const decided = open.filter((item) => item.decision).length;
  const archived = state.project.state === 'ARCHIVED';
  const toPublish = open.filter((item) => item.decision).length;
  const partial = batch.completeness === 'PARTIAL';
  const publish =
    archived || toPublish === 0
      ? ''
      : partial
        ? state.confirm === 'publish-partial'
          ? `<span class="confirm" role="group"><small>${esc(r.partialNote)}</small><button class="btn primary" data-action="publish-confirm">${esc(r.publishPartial)}</button><button class="btn ghost" data-action="confirm-cancel">${esc(t.cancelAction)}</button></span>`
          : `<button class="btn primary" data-action="publish" ${state.req.busy ? 'disabled' : ''}>${esc(state.req.busy ? r.publishing : r.publish(toPublish))}</button>`
        : `<button class="btn primary" data-action="publish" ${state.req.busy ? 'disabled' : ''}>${esc(state.req.busy ? r.publishing : r.publish(toPublish))}</button>`;
  const sub = `<code>${esc(batch.id)}</code> · ${esc(r.batchLine(sourceName(batch.connector), batch.source.title || r.untitled, r.completeness[batch.completeness] ?? batch.completeness))} · ${esc(r.decidedText(decided, open.length))}`;
  const title = `${esc(r.validateTitle)} ${pill(batch.status, r.statuses[batch.status] ?? batch.status)}`;
  const issues = batch.issues;
  const issueCard = `<section class="card"><h2>${esc(r.issuesTitle)}</h2>${
    issues.length === 0
      ? `<p class="mu">${esc(r.noIssue)}</p>`
      : `<ul class="plain">${issues
          .map(
            (issue) =>
              `<li class="issue">${pill(issue.severity === 'ERROR' ? 'FAILED' : issue.severity === 'WARNING' ? 'INCOMPLETE' : 'UNKNOWN', r.issueSeverities[issue.severity] ?? issue.severity)}<span>${esc(issue.message)}${issue.location ? `<small class="mu block">${esc(r.location(issue.location))}</small>` : ''}</span></li>`,
          )
          .join('')}</ul>`
  }</section>`;
  const missing = `<section class="card"><h2>${esc(r.missingTitle)}</h2><p class="mu">${esc(batch.missingFromSource.length > 0 ? r.missing(batch.missingFromSource.length) : r.noMissing)}</p>${batch.missingFromSource.length > 0 ? `<p>${batch.missingFromSource.map((id) => `<code>${esc(id)}</code>`).join(' ')}</p>` : ''}</section>`;
  const note = `<p class="note">${icon('alert')}<span>${esc(r.decisionNote)} ${esc(r.authorNote)}</span></p>${partial ? `<p class="note warn">${icon('alert')}<span>${esc(r.partialNote)}</span></p>` : ''}`;
  const information = batch.items.filter((item) => item.kind === 'INFORMATION');
  const informationList =
    information.length === 0
      ? ''
      : `<details class="info-list"><summary>${esc(r.informationCount(information.length))}</summary><ul class="plain tight">${information.map((item) => `<li class="mu">${esc(item.title)}</li>`).join('')}</ul></details>`;
  const list = `<section class="card"><div class="cands">${candidates.length === 0 ? `<p class="mu">${esc(r.noCandidate)}</p>` : candidates.map((item) => candidate(state, item, batch)).join('')}</div>${informationList}${state.req.error ? `<p class="err" role="alert">${esc(state.req.error)}</p>` : ''}</section>`;
  return `${header(title, { sub, back, actions: publish })}${note}<div class="split"><div class="col">${list}</div><aside class="col narrow">${issueCard}${missing}</aside></div>`;
}

// ── Référentiel ────────────────────────────────────────────────────────────────────────────────

function selectors(state: DashboardState): string {
  const r = state.t.req;
  const ui = state.req;
  return `<label class="pick">${esc(r.kindLabel)} <select data-action="req-kind"><option value="ALL">${esc(r.allKinds)}</option>${KINDS.map((kind) => `<option value="${kind}" ${ui.kind === kind ? 'selected' : ''}>${esc(r.kinds[kind] ?? kind)}</option>`).join('')}</select></label><label class="pick">${esc(r.sourceLabel)} <select data-action="req-source"><option value="ALL">${esc(r.allSources)}</option>${SOURCE_KINDS.map((kind) => `<option value="${kind}" ${ui.source === kind ? 'selected' : ''}>${esc(sourceName(kind))}</option>`).join('')}</select></label>`;
}

const keep = (state: DashboardState, kind: string, sources: readonly string[]): boolean =>
  (state.req.kind === 'ALL' || state.req.kind === kind) &&
  (state.req.source === 'ALL' || sources.includes(state.req.source));

function linkLine(state: DashboardState, cell: MatrixLinkCell, withActions: boolean): string {
  const r = state.t.req;
  const archived = state.project?.state === 'ARCHIVED';
  const actions =
    withActions && !archived && cell.validation === 'PROPOSED'
      ? `<span class="row-acts"><button class="btn" data-action="link-decide" data-link="${esc(cell.linkId)}" data-decision="CONFIRM">${esc(r.confirmLink)}</button><button class="btn ghost" data-action="link-decide" data-link="${esc(cell.linkId)}" data-decision="REJECT">${esc(r.rejectLink)}</button></span>`
      : withActions && !archived && cell.validation === 'CONFIRMED'
        ? `<span class="row-acts"><button class="btn ghost" data-action="link-decide" data-link="${esc(cell.linkId)}" data-decision="REJECT">${esc(r.rejectLink)}</button></span>`
        : '';
  const target = cell.label ?? labelOf(state, cell.target.id);
  return `<li class="lk"><span>${esc(r.linkTypes[cell.type] ?? cell.type)} <code>${esc(target === cell.target.id ? `${cell.target.kind}:${target}` : target)}</code></span>${pill(cell.validation, r.validations[cell.validation] ?? cell.validation)}${cell.freshness === 'POSSIBLY_STALE' ? ` <span class="pill warn">${esc(r.stale)}</span>` : ''}${actions}</li>`;
}

function entityDetail(state: DashboardState, entity: CanonicalEntity, withLinks: boolean): string {
  const t = state.t;
  const r = t.req;
  const links = (state.req.repository?.links ?? []).filter(
    (link) => link.from.id === entity.id || link.to.id === entity.id,
  );
  const linkItems = links
    .map((link) => {
      const cell: MatrixLinkCell = {
        linkId: link.id,
        type: link.type,
        target: link.from.id === entity.id ? link.to : link.from,
        validation: link.validation,
        freshness: link.freshness,
        confidence: link.confidence,
      };
      return `${linkLine(state, cell, withLinks)}${link.justification.length > 0 ? `<li class="mu just">${esc(r.justification)} : ${esc(link.justification.join(' ; '))} · ${esc(r.confidence(link.confidence))}</li>` : ''}`;
    })
    .join('');
  const sources = entity.sources
    .map(
      (source) =>
        `<li><b>${esc(sourceName(source.kind))}</b> · ${esc(source.title)}${source.version ? ` · v${esc(source.version)}` : ''}<small class="mu block">${esc(r.location(source.location))}</small></li>`,
    )
    .join('');
  const history = [...entity.history]
    .reverse()
    .map(
      (revision) =>
        `<li><b>${esc(r.version(revision.version))}</b> · ${esc(r.changes[revision.change] ?? revision.change)} · ${esc(formatDate(revision.at, t.locale))}${revision.edited ? ` · ${esc(r.edited)}` : ''}${revision.previous ? `<small class="mu block">${esc(revision.previous.title)}</small>` : ''}</li>`,
    )
    .join('');
  const archived = state.project?.state === 'ARCHIVED';
  const form = state.req.linkForm;
  const addLink =
    !withLinks || archived
      ? ''
      : form
        ? `<form class="col link-form" data-action="link-form"><div class="fields"><label class="field">${esc(r.linkType)}<select data-link-field="type">${ADDABLE_LINKS.map((type) => `<option value="${type}" ${form.type === type ? 'selected' : ''}>${esc(r.linkTypes[type] ?? type)}</option>`).join('')}</select></label><label class="field">${esc(r.targetKind)}<select data-link-field="targetKind">${TARGET_KINDS.map((kind) => `<option value="${kind}" ${form.targetKind === kind ? 'selected' : ''}>${esc(r.targetKinds[kind] ?? kind)}</option>`).join('')}</select></label></div><label class="field">${esc(r.targetId)}<input data-link-field="targetId" class="mono" value="${esc(form.targetId)}"></label><label class="field">${esc(r.justificationField)}<textarea data-link-field="justification" rows="2">${esc(form.justification)}</textarea></label><div class="form-acts start"><button type="button" class="btn primary" data-action="link-add">${esc(r.addLinkSave)}</button><button type="button" class="btn ghost" data-action="link-cancel">${esc(t.cancelAction)}</button></div>${state.req.error ? `<p class="err" role="alert">${esc(state.req.error)}</p>` : ''}</form>`
        : `<button class="btn" data-action="link-open">${esc(r.addLink)}</button>`;
  return `<section class="card"><div class="card-h"><h2>${entity.externalId ? `<code>${esc(entity.externalId)}</code> ` : ''}${esc(r.kinds[entity.kind] ?? entity.kind)}</h2><span class="mu">${esc(r.version(entity.version))}</span></div><p class="big-name">${esc(entity.title)}</p>${entity.description && entity.description !== entity.title ? `<p>${esc(entity.description)}</p>` : ''}
<h3 class="section-t">${esc(r.linksTitle)}</h3>${links.length === 0 ? `<p class="mu">${esc(r.noLink)}</p>` : `<ul class="plain">${linkItems}</ul>`}${addLink}
<h3 class="section-t">${esc(r.provenance)}</h3><ul class="plain">${sources}</ul>
<h3 class="section-t">${esc(r.historyTitle)}</h3><ul class="plain tight">${history}</ul></section>`;
}

export function requirementsView(state: DashboardState): string {
  const t = state.t;
  const r = t.req;
  const waiting = needsProject(state, t.nav.requirements);
  if (waiting) return waiting;
  const repository = state.req.repository;
  const route = state.route;
  const selected = route.view === 'requirements' ? route.entityId : undefined;
  if (!repository)
    return `${header(esc(t.nav.requirements))}<section class="msg"><span class="spin" aria-hidden="true"></span><p class="mu">${esc(t.loading)}</p></section>`;
  const sub = esc(r.repoSub(repository.entities.length, repository.pending));
  if (repository.entities.length === 0)
    return `${header(esc(t.nav.requirements), { sub })}<section class="card"><p class="mu">${esc(r.noEntity)}</p><button class="btn primary" data-action="nav" data-view="sources">${esc(r.newImport)}</button></section>`;
  const shown = repository.entities.filter((entity) =>
    keep(
      state,
      entity.kind,
      entity.sources.map((source) => source.kind),
    ),
  );
  const list =
    shown.length === 0
      ? `<p class="mu">${esc(r.noMatch)}</p>`
      : `<ul class="plain ents">${shown
          .map(
            (entity) =>
              `<li><button class="ent ${entity.id === selected ? 'sel' : ''}" data-action="pick-entity" data-entity="${esc(entity.id)}" ${entity.id === selected ? 'aria-current="true"' : ''}><span class="tag-k">${esc(r.kinds[entity.kind] ?? entity.kind)}</span>${entity.externalId ? `<code>${esc(entity.externalId)}</code>` : ''}<span class="ent-t">${esc(entity.title)}</span><small class="mu">${esc(r.version(entity.version))}</small></button></li>`,
          )
          .join('')}</ul>`;
  const entity = repository.entities.find((candidate) => candidate.id === selected);
  const detail = entity
    ? entityDetail(state, entity, true)
    : `<section class="card"><p class="mu">${esc(r.pickEntity)}</p></section>`;
  return `${header(esc(t.nav.requirements), { sub, actions: selectors(state) })}<div class="split"><section class="card">${list}</section><aside class="col narrow wide-aside">${detail}</aside></div>`;
}

// ── Matrice de traçabilité ─────────────────────────────────────────────────────────────────────

const cellList = (state: DashboardState, cells: MatrixLinkCell[]): string =>
  cells.length === 0
    ? '<span class="mu">—</span>'
    : cells
        .map(
          (cell) =>
            `<span class="mx ${cell.validation === 'CONFIRMED' ? 'on' : cell.validation === 'REJECTED' ? 'off' : 'prop'}" title="${esc(state.t.req.validations[cell.validation] ?? cell.validation)}"><code>${esc(cell.label ?? cell.target.id)}</code></span>`,
        )
        .join(' ');

export function traceabilityView(state: DashboardState): string {
  const t = state.t;
  const r = t.req;
  const waiting = needsProject(state, r.matrixTitle);
  if (waiting) return waiting;
  const rows = state.req.matrix;
  if (!rows)
    return `${header(esc(r.matrixTitle))}<section class="msg"><span class="spin" aria-hidden="true"></span><p class="mu">${esc(t.loading)}</p></section>`;
  const route = state.route;
  const selected = route.view === 'traceability' ? route.entityId : undefined;
  const actions = `${selectors(state)}<button class="btn" data-action="export-csv">${icon('download')}<span>${esc(r.exportCsv)}</span></button>`;
  const shown = rows.filter((row) => keep(state, row.kind, row.sources));
  const label = (row: MatrixRow): string => row.externalId ?? row.id;
  const table =
    rows.length === 0
      ? `<p class="mu">${esc(r.noEntity)}</p>`
      : shown.length === 0
        ? `<p class="mu">${esc(r.noMatch)}</p>`
        : `<div class="tw"><table class="tbl mtx"><thead><tr><th scope="col">${esc(r.colElement)}</th><th scope="col">${esc(r.colChildren)}</th><th scope="col">${esc(r.colImplemented)}</th><th scope="col">${esc(r.colVerified)}</th><th scope="col">${esc(r.colOther)}</th></tr></thead><tbody>${shown
            .map(
              (row) =>
                `<tr class="${row.id === selected ? 'sel' : ''}"><th scope="row"><button class="lnk" data-action="pick-trace" data-entity="${esc(row.id)}"><code>${esc(label(row))}</code></button><small class="mu block">${esc(r.kinds[row.kind] ?? row.kind)} · ${esc(row.title)}</small></th><td>${cellList(state, row.children)}</td><td>${cellList(state, row.implementedBy)}</td><td>${cellList(state, row.verifiedBy)}</td><td>${cellList(state, row.other)}</td></tr>`,
            )
            .join('')}</tbody></table></div>`;
  const entity = state.req.repository?.entities.find((candidate) => candidate.id === selected);
  const detail = entity
    ? `<aside class="col narrow wide-aside">${entityDetail(state, entity, true)}</aside>`
    : '';
  return `${header(esc(r.matrixTitle), { sub: esc(r.matrixSub(rows.length)), actions })}<p class="note">${icon('alert')}<span>${esc(r.correlationNote)}</span></p><div class="${detail ? 'split' : ''}"><section class="card">${table}</section>${detail}</div>`;
}

// ── Indicateurs ────────────────────────────────────────────────────────────────────────────────

function indicatorCard(
  title: string,
  computedAt: string,
  ratio: Ratio | undefined,
  lines: [string, string][],
  extra = '',
): string {
  const value = ratio
    ? `<b class="big">${esc(percent(ratio))}</b><small>${esc(`${String(ratio.numerator)} / ${String(ratio.denominator)}`)}</small>`
    : '';
  return `<section class="card ind"><div class="card-h"><h2>${esc(title)}</h2><small class="mu">${esc(computedAt)}</small></div><div class="ind-v">${value}</div>${extra}<dl class="ind-dl">${lines.map(([term, text]) => `<dt>${esc(term)}</dt><dd>${esc(text)}</dd>`).join('')}</dl></section>`;
}

export function indicatorsView(state: DashboardState): string {
  const t = state.t;
  const r = t.req;
  const waiting = needsProject(state, t.nav.indicators);
  if (waiting) return waiting;
  const data = state.req.indicators;
  const actions = `<label class="pick">${esc(t.period)} <select data-action="period">${[1, 7, 30].map((days) => `<option value="${String(days)}" ${days === state.days ? 'selected' : ''}>${esc(t.days(days))}</option>`).join('')}</select></label>`;
  const sub = `${esc(state.project?.name ?? '')} · ${esc(r.indicatorsSub)}`;
  if (!data)
    return `${header(esc(t.nav.indicators), { sub, actions })}<section class="msg"><span class="spin" aria-hidden="true"></span><p class="mu">${esc(t.loading)}</p></section>`;
  const at = r.computedAt(formatDate(data.generatedAt, t.locale));
  const none = (ratio: Ratio): string => (ratio.denominator === 0 ? ` (${r.noDenominator})` : '');
  const coverage = indicatorCard(r.coverage.title, at, data.coverage, [
    [r.formula, r.coverage.formula],
    [r.denominator, r.coverage.denominator(data.coverage.denominator) + none(data.coverage)],
    [r.exclusions, r.coverage.exclusions(data.coverage.proposedOnly)],
    [r.limits, r.coverage.limits],
  ]);
  const evidence = `<section class="card ind"><div class="card-h"><h2>${esc(r.evidence.title)}</h2></div><div class="ind-v"><b class="big">—</b></div><p class="note">${icon('alert')}<span>${esc(r.evidence.unavailable)}</span></p></section>`;
  const replays = indicatorCard(r.replays.title, at, data.replays, [
    [r.formula, r.replays.formula],
    [r.denominator, r.replays.denominator(data.replays.denominator, data.period.days) + none(data.replays)],
    [r.exclusions, r.replays.exclusions(data.replays.cancelled, data.replays.withoutVerdict)],
    [r.limits, r.replays.limits],
  ]);
  const links = indicatorCard(
    r.links.title,
    at,
    data.links,
    [
      [r.formula, r.links.formula],
      [r.exclusions, r.links.exclusions(data.links.rejected)],
      [r.limits, r.links.limits],
    ],
    `<p class="mu">${esc(r.links.breakdown(data.links.confirmed, data.links.proposed, data.links.possiblyStale))}</p>`,
  );
  const gaps = `<section class="card wide"><h2>${esc(r.gapsTitle)}</h2><div class="tiles">${(
    [
      ['withoutImplementation', data.gaps.withoutImplementation],
      ['withoutTest', data.gaps.withoutTest],
      ['staleLinks', data.gaps.staleLinks],
      ['pendingCandidates', data.gaps.pendingCandidates],
    ] as const
  )
    .map(
      ([key, count]) =>
        `<div class="tile ${count > 0 ? 'warn' : ''}"><b>${String(count)}</b><span>${esc(r.gaps[key])}</span></div>`,
    )
    .join('')}</div></section>`;
  return `${header(esc(t.nav.indicators), { sub, actions })}<div class="ind-grid">${coverage}${evidence}${replays}${links}</div>${gaps}`;
}

// ── Tendances ──────────────────────────────────────────────────────────────────────────────────

function columns(
  weeks: TrendsView['weeks'],
  label: (week: string) => string,
  value: (week: TrendsView['weeks'][number]) => number | undefined,
  text: (week: TrendsView['weeks'][number]) => string,
  options: { max?: number; short?: (week: TrendsView['weeks'][number]) => string } = {},
): string {
  // Un taux se dessine sur 0 à 100 ; une quantité, par rapport à la plus grande de la période.
  const max = options.max ?? Math.max(1, ...weeks.map((week) => value(week) ?? 0));
  return `<div class="bars wk">${weeks
    .map((week) => {
      const v = value(week);
      const description = `${label(week.week)} : ${text(week)}`;
      return `<div class="bar" role="img" aria-label="${esc(description)}" title="${esc(description)}">${
        v === undefined
          ? '<span class="none"></span>'
          : `<span class="p" style="height:${String(Math.round((v / max) * 100))}%"></span><b class="v">${esc(options.short ? options.short(week) : String(v))}</b>`
      }<small>${esc(label(week.week))}</small></div>`;
    })
    .join('')}</div>`;
}

export function trendsView(state: DashboardState): string {
  const t = state.t;
  const r = t.req;
  const data = state.req.trends;
  const scope = state.project && state.projectId ? state.project.name : t.allProjects;
  const actions = `<label class="pick">${esc(t.period)} <select data-action="trend-weeks">${TREND_WEEKS.map((weeks) => `<option value="${String(weeks)}" ${weeks === state.req.weeks ? 'selected' : ''}>${esc(r.weeks(weeks))}</option>`).join('')}</select></label>`;
  const sub = esc(r.trendsSub(scope, state.req.weeks));
  if (!data)
    return `${header(esc(t.nav.trends), { sub, actions })}<section class="msg"><span class="spin" aria-hidden="true"></span><p class="mu">${esc(t.loading)}</p></section>`;
  const weeks = data.weeks;
  const rate = `<section class="card wide"><h2>${esc(r.passRateTitle)}</h2>${columns(
    weeks,
    r.weekLabel,
    (week) => (week.replays.value === undefined ? undefined : week.replays.value * 100),
    (week) =>
      week.replays.value === undefined
        ? r.noReplay
        : `${percent(week.replays)} (${String(week.replays.numerator)} / ${String(week.replays.denominator)})`,
    { max: 100, short: (week) => percent(week.replays) },
  )}<p class="mu">${esc(r.passRateNote)}</p></section>`;
  const totals = (week: TrendsView['weeks'][number]): number =>
    week.issues.CRITICAL + week.issues.ERROR + week.issues.WARNING + week.issues.INFO;
  const issues = `<section class="card"><h2>${esc(r.issuesTitle2)}</h2>${columns(
    weeks,
    r.weekLabel,
    totals,
    (week) =>
      `${String(week.issues.CRITICAL)} ${t.severities.CRITICAL ?? 'CRITICAL'}, ${String(week.issues.ERROR)} ${t.severities.ERROR ?? 'ERROR'}, ${String(week.issues.WARNING)} ${t.severities.WARNING ?? 'WARNING'}, ${String(week.issues.INFO)} ${t.severities.INFO ?? 'INFO'}`,
  )}</section>`;
  const median = `<section class="card"><h2>${esc(r.medianTitle)}</h2>${columns(
    weeks,
    r.weekLabel,
    (week) => week.medianReplayMs,
    (week) => (week.medianReplayMs === undefined ? r.noReplay : t.duration(week.medianReplayMs)),
    { short: (week) => (week.medianReplayMs === undefined ? '' : t.duration(week.medianReplayMs)) },
  )}<p class="mu">${esc(r.medianNote)}</p></section>`;
  const unstable = `<section class="card"><h2>${esc(r.unstableTitle)}</h2><p class="mu">${esc(r.unstableNote)}</p>${
    data.unstable.length === 0
      ? `<p class="mu">${esc(r.noUnstable)}</p>`
      : `<ul class="plain">${data.unstable
          .map(
            (entry) =>
              `<li><code>${esc(entry.name)}</code> <span class="mu">· ${esc(entry.projectName)} · ${esc(r.flipsOf(entry.flips, entry.runs))}</span></li>`,
          )
          .join('')}</ul>`
  }</section>`;
  const hasCoverage = weeks.some((week) => week.coverage);
  const coverage = `<section class="card"><h2>${esc(r.coverageTitle)}</h2>${
    hasCoverage
      ? columns(
          weeks,
          r.weekLabel,
          (week) => (week.coverage?.value === undefined ? undefined : week.coverage.value * 100),
          (week) =>
            week.coverage
              ? `${percent(week.coverage)} (${String(week.coverage.numerator)} / ${String(week.coverage.denominator)})`
              : '—',
          { max: 100, short: (week) => (week.coverage ? percent(week.coverage) : '') },
        )
      : `<p class="mu">${esc(r.noCoverage)}</p>`
  }<p class="mu">${esc(r.coverageNote)}</p></section>`;
  return `${header(esc(t.nav.trends), { sub, actions })}${rate}<div class="grid2">${issues}${median}${unstable}${coverage}</div>`;
}
