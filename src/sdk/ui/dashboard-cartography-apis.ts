import type { ApiService, ApiSheet, Evidence, MapPage } from '../core/cartography.js';
import type { ScenarioView } from '../core/contracts.js';
import {
  breakable,
  chainPath,
  fullGraphSvg,
  nodeText,
  pathCards,
  type TailCard,
} from './dashboard-cartography-graph.js';
import type { MapStrings } from './dashboard-cartography-i18n.js';
import type { CartographyUi } from './dashboard-cartography.js';
import { icon } from './dashboard-parts.js';
import { esc } from './view.js';

/**
 * L'ONGLET « API & SERVICES » : le catalogue (recherche, périmètre, tri et pagination côté serveur), la
 * fiche de l'API choisie (parcours d'intégration démontré, informations, contrat), ses détails et les
 * champs échangés, puis les fonctionnalités et scénarios qui la consomment. Tout vient du scan : une
 * information absente est dite absente, jamais complétée.
 */

export const API_TABS = ['summary', 'endpoints', 'trace', 'features', 'scenarios', 'impacts'] as const;
export type ApiTab = (typeof API_TABS)[number];

export interface ApiViewHelpers {
  chip: (raw: string, text: string) => string;
  conf: (value: string) => string;
  evidence: (evidence: Evidence | undefined) => string;
  where: (evidence: Evidence | undefined) => string;
  date: (iso: string | undefined) => string;
  pager: (list: string, page: MapPage<unknown>, sizes: readonly number[]) => string;
  spinner: () => string;
  paneError: (text: string | undefined) => string;
  canDecide: boolean;
  canRun: boolean;
  environments: { id: string; name: string }[];
  scenarios: ScenarioView[];
}

const SCOPE_ICON: Record<string, string> = { INTERNAL: 'code', EXTERNAL: 'cloud', UNCLASSIFIED: 'alert' };
const SCOPE_TONE: Record<string, string> = { INTERNAL: 'int', EXTERNAL: 'ext', UNCLASSIFIED: 'unk' };
const STATUS_TONE: Record<string, string> = {
  DETECTED: 'CONFIRMED',
  PROBABLE: 'PROBABLE',
  TO_CLASSIFY: 'PROPOSED',
  OBSOLETE: 'CANCELLED',
};

function scopeBadge(m: MapStrings, api: { scope: string; owner?: string; provider?: string }): string {
  const where =
    api.scope === 'INTERNAL'
      ? (m.layers[api.owner ?? ''] ?? api.owner ?? '')
      : api.scope === 'EXTERNAL'
        ? (api.provider ?? '')
        : '';
  return `<span class="map-abadge ${SCOPE_TONE[api.scope] ?? 'unk'}">${esc(m.a.scopeBadge[api.scope] ?? api.scope)}${where ? ` · ${esc(where)}` : ''}</span>`;
}

function statusBadge(m: MapStrings, h: ApiViewHelpers, status: string): string {
  return h.chip(
    STATUS_TONE[status] ?? 'PROPOSED',
    `${status === 'DETECTED' ? '✓ ' : ''}${m.a.status[status] ?? status}`,
  );
}

/** La colonne gauche : le catalogue. */
function catalogCard(m: MapStrings, ui: CartographyUi, h: ApiViewHelpers): string {
  const page = ui.apis;
  const c = ui.apiCriteria;
  const scope = ui.apiScope;
  const counts = page?.counts ?? { all: 0, internal: 0, external: 0, unclassified: 0 };
  const chip = (value: string, count: number): string =>
    `<button class="map-scope${scope === value ? ' on' : ''}" data-action="map-api-scope" data-scope="${esc(value)}" aria-pressed="${String(scope === value)}">${esc(m.a.scopes[value || 'all'] ?? value)} (${String(count)})</button>`;
  const chips = `<div class="map-scopes">${chip('', counts.all)}${chip('INTERNAL', counts.internal)}${chip('EXTERNAL', counts.external)}${counts.unclassified > 0 || scope === 'UNCLASSIFIED' ? chip('UNCLASSIFIED', counts.unclassified) : ''}</div>`;
  const sort = ui.showApiSort
    ? `<div class="map-filters"><label class="pick"><select data-map="a-sort" aria-label="${esc(m.a.sortBy)}">${['name', 'endpoints', 'features'].map((s) => `<option value="${s}" ${s === (c.sort || 'name') ? 'selected' : ''}>${esc(m.a.sortBy)} : ${esc(m.a.sorts[s] ?? s)}</option>`).join('')}</select></label></div>`
    : '';
  const items = (page?.items ?? [])
    .map((row) => {
      const selected = row.id === ui.api;
      return `<li><button class="map-aitem${selected ? ' sel' : ''} ${SCOPE_TONE[row.scope] ?? ''}" data-action="map-api" data-api="${esc(row.id)}" data-nav="apis" aria-pressed="${String(selected)}"><span class="map-aitem-i">${icon(SCOPE_ICON[row.scope] ?? 'code')}</span><span class="map-aitem-n"><b>${esc(row.name)}</b><small class="mono">${esc(row.firstEndpoint ?? '')}${row.endpoints > 1 ? ` <span class="mu">+${String(row.endpoints - 1)}</span>` : ''}</small></span><span class="map-aitem-b">${scopeBadge(m, row)}${statusBadge(m, h, row.status)}</span></button></li>`;
    })
    .join('');
  const body =
    ui.loading.apis && !page
      ? h.spinner()
      : page && !page.available
        ? `<p class="map-note warn-t small" role="note">${esc(m.a.notAvailable)}</p>`
        : page && page.total === 0
          ? `<p class="mu">${esc(m.a.noApi)}</p>`
          : `<ul class="map-items map-aitems" aria-busy="${String(Boolean(ui.loading.apis))}">${items}</ul>`;
  return `<section class="card map-acat"><h2>${icon('cloud')}<span>${esc(m.a.catalog(page?.kpis.apis ?? 0))}</span></h2><div class="map-filters"><label class="map-search">${icon('search')}<input type="search" data-map="a-q" value="${esc(c.q)}" placeholder="${esc(m.a.search)}" aria-label="${esc(m.a.search)}"></label><button class="btn small icon-only" data-action="map-api-sort" aria-expanded="${String(Boolean(ui.showApiSort))}" aria-label="${esc(m.a.sortBy)}" title="${esc(m.a.sortBy)}">${icon('sliders')}</button></div>${sort}${chips}${h.paneError(ui.errors.apis)}${body}${page ? h.pager('apis', page, [5, 10, 20, 50]) : ''}</section>`;
}

/** La description d'une API, faite de ses seules données. */
function describe(m: MapStrings, api: ApiService): string {
  if (api.scope === 'INTERNAL')
    return m.a.describe.INTERNAL(
      m.layers[api.owner ?? ''] ?? api.owner ?? '',
      api.technicalName,
      api.endpoints.length,
    );
  if (api.scope === 'EXTERNAL')
    return m.a.describe.EXTERNAL(
      api.consumers.map((l) => m.layers[l] ?? l).join(', ') || '—',
      api.provider ?? '',
    );
  return m.a.describe.UNCLASSIFIED(api.calls[0]?.how ?? '—');
}

/** Le parcours d'intégration : les couches traversées jusqu'à l'API (carte finale), sans rien inventer. */
function integrationPath(m: MapStrings, ui: CartographyUi, sheet: ApiSheet): string {
  const api = sheet.api;
  // Pour une API interne, l'endpoint est déjà le dernier nœud du parcours ; pour une externe, la carte finale l'ajoute.
  const nodes = sheet.path.nodes;
  const path = chainPath(nodes, sheet.path.edges);
  const first = api.endpoints[0];
  const tail: TailCard | undefined =
    api.scope === 'INTERNAL'
      ? undefined
      : {
          title: api.scope === 'EXTERNAL' ? m.a.externalCard : m.a.unclassifiedCard,
          ...(api.provider ? { tech: api.provider } : {}),
          icon: SCOPE_ICON[api.scope] ?? 'cloud',
          line1: api.name.replace(/^API\s+/, ''),
          line2: first ? `${first.method ?? '?'} ${first.path ?? m.a.dynamic}` : m.a.dynamic,
          confidence: api.confidence,
          tone: api.scope === 'EXTERNAL' ? 'external' : 'unclassified',
          link: api.confidence,
        };
  if (nodes.length === 0 && !tail) return `<p class="mu">${esc(m.a.pathEmpty)}</p>`;
  return `<div class="map-canvas path" data-map-canvas tabindex="0" aria-label="${esc(m.a.pathTitle)}"><div class="map-canvas-in" style="transform:translate(${String(ui.panX)}px,${String(ui.panY)}px) scale(${String(ui.zoom)})">${pathCards(
    {
      m,
      ...(ui.summary ? { summary: ui.summary } : {}),
      grouped: true,
      ...(ui.graphSel ? { selection: ui.graphSel } : {}),
      focus: nodes.at(-1)?.id ?? '',
    },
    path,
    tail,
  )}</div></div>`;
}

function generalCard(m: MapStrings, ui: CartographyUi, h: ApiViewHelpers, sheet: ApiSheet): string {
  const api = sheet.api;
  const renaming = ui.apiRename !== undefined;
  const nameRow = renaming
    ? `<form class="map-arename" data-action="map-api-rename"><input data-map="api-name" value="${esc(ui.apiRename ?? '')}" maxlength="120" aria-label="${esc(m.a.businessName)}" autocomplete="off"><button class="btn small primary" type="submit" ${ui.decisionBusy ? 'disabled' : ''}>${esc(m.a.renameSave)}</button><button class="btn small ghost" type="button" data-action="map-api-rename-cancel">${esc(m.a.renameCancel)}</button></form>`
    : `<span>${esc(api.name)}</span>${h.canDecide ? `<button class="btn small ghost icon-only" data-action="map-api-rename-open" aria-label="${esc(m.a.rename)}" title="${esc(m.a.rename)}">${icon('edit')}</button>` : ''}`;
  const base = api.baseUrl
    ? `<code class="map-loc">${esc(api.baseUrl)}</code><button class="btn small ghost icon-only" data-action="map-api-copy" data-text="${esc(api.baseUrl)}" aria-label="${esc(m.a.copy)}" title="${esc(m.a.copy)}">${icon('copy')}</button>`
    : '<span class="mu">—</span>';
  return `<section class="card map-agen"><h3>${icon('requirements')}<span>${esc(m.a.general)}</span></h3><dl class="map-dl map-adl"><dt>${esc(m.a.businessName)}</dt><dd>${nameRow}</dd><dt>${esc(m.a.technicalName)}</dt><dd class="mono">${esc(api.technicalName)}</dd><dt>${esc(m.a.typeLabel)}</dt><dd>${esc(m.a.type[api.scope] ?? api.scope)}</dd><dt>${esc(m.a.provider)}</dt><dd>${esc(api.provider ?? '—')}</dd><dt>${esc(m.a.baseUrl)}</dt><dd>${base}</dd>${api.properties.length ? `<dt>${esc(m.a.properties)}</dt><dd class="mono">${esc(api.properties.join(', '))}</dd>` : ''}${api.clients.length ? `<dt>${esc(m.a.clients)}</dt><dd>${esc(api.clients.join(', '))}</dd>` : ''}<dt>${esc(m.a.auth)}</dt><dd class="mu">${esc(m.a.authUnknown)}</dd><dt>${esc(m.a.statusLabel)}</dt><dd>${statusBadge(m, h, api.status)}</dd><dt>${esc(m.a.lastDetection)}</dt><dd>${esc(h.date(sheet.scannedAt))}</dd></dl></section>`;
}

function contractCard(m: MapStrings, h: ApiViewHelpers, sheet: ApiSheet): string {
  const contract = sheet.api.contract;
  if (!contract)
    return `<section class="card map-acon"><h3>${icon('file')}<span>${esc(m.a.contract)}</span></h3><p class="mu small">${esc(m.a.noContract)}</p></section>`;
  const evidence: Evidence = {
    kind: 'OPENAPI',
    sourceId: contract.sourceId,
    file: contract.file,
    line: 1,
    confidence: 'CONFIRMED',
  };
  return `<section class="card map-acon"><h3>${icon('file')}<span>${esc(m.a.contract)}</span></h3><dl class="map-dl map-adl"><dt>${esc(m.a.contractFile)}</dt><dd><code class="map-loc">${esc(contract.file)}</code> ${h.evidence(evidence)}</dd><dt>${esc(m.a.version)}</dt><dd>${esc(contract.version ?? '—')}</dd><dt>${esc(m.a.format)}</dt><dd>${esc(contract.format)}</dd><dt>${esc(m.a.documentation)}</dt><dd>${contract.documentation ? `<a href="${esc(contract.documentation)}" target="_blank" rel="noopener noreferrer">${esc(m.a.openDoc)} ${icon('right')}</a>` : `<span class="mu">${esc(m.a.noDoc)}</span>`}</dd></dl></section>`;
}

function endpointsPane(m: MapStrings, h: ApiViewHelpers, sheet: ApiSheet): string {
  const rows = sheet.api.endpoints
    .map((ep) => {
      const callers = sheet.api.calls.filter((c) => c.endpoint === ep.id);
      return `<tr><td><span class="map-verb2">${esc(ep.method ?? '?')}</span></td><td class="mono">${breakable(ep.path ?? m.a.dynamic)}</td><td class="mono">${esc(ep.requestType ?? '—')}</td><td class="mono">${esc(ep.responseType ?? '—')}</td><td>${ep.contract ? h.chip('CONFIRMED', '✓') : '<span class="mu">—</span>'}</td><td>${h.conf(ep.confidence)}</td><td>${callers.length ? `<small class="mu">${esc(callers.map((c) => nodeText(undefined, c.from.split('#').pop() ?? c.from).name).join(', '))}</small>` : ''} ${h.evidence(ep.evidence.find((e) => e.file) ?? callers[0]?.evidence[0])}</td></tr>`;
    })
    .join('');
  return `<div class="tbl-w"><table class="tbl map-tbl map-atbl"><thead><tr><th>${esc(m.a.colMethod)}</th><th>${esc(m.a.colPath)}</th><th>${esc(m.a.colRequest)}</th><th>${esc(m.a.colResponse)}</th><th>${esc(m.a.colContract)}</th><th>${esc(m.a.colConfidence)}</th><th>${esc(m.a.colEvidence)}</th></tr></thead><tbody>${rows}</tbody></table></div><h4>${esc(m.a.reasons)}</h4><ul class="map-why">${sheet.api.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`;
}

function tracePane(m: MapStrings, ui: CartographyUi, sheet: ApiSheet): string {
  const focus = sheet.path.nodes.at(-1)?.id ?? sheet.api.calls[0]?.from ?? '';
  const toolbar = `<div class="map-gtools"><div class="map-seg" role="tablist"><button role="tab" data-action="map-g-mode" data-mode="path" aria-selected="${String(ui.graphMode === 'path')}">${esc(m.g.mainPath)}</button><button role="tab" data-action="map-g-mode" data-mode="full" aria-selected="${String(ui.graphMode === 'full')}">${esc(m.g.fullGraph)}</button></div><span class="map-gbtns"><button class="btn small icon-only" data-action="map-g-full" aria-pressed="${String(ui.fullscreen)}" aria-label="${esc(ui.fullscreen ? m.g.exitFullscreen : m.g.fullscreen)}" title="${esc(ui.fullscreen ? m.g.exitFullscreen : m.g.fullscreen)}">${icon(ui.fullscreen ? 'minimize' : 'maximize')}</button><button class="btn small icon-only" data-action="map-g-fit" aria-label="${esc(m.g.fit)}" title="${esc(m.g.fit)}">${icon('fit')}</button><button class="btn small icon-only" data-action="map-g-zoom" data-dir="-1" aria-label="${esc(m.g.zoomOut)}" title="${esc(m.g.zoomOut)}">${icon('minus')}</button><output class="map-gzoom">${esc(m.g.zoomLevel(ui.zoom))}</output><button class="btn small icon-only" data-action="map-g-zoom" data-dir="1" aria-label="${esc(m.g.zoomIn)}" title="${esc(m.g.zoomIn)}">${icon('plus')}</button></span></div>`;
  const content =
    ui.graphMode === 'full'
      ? `<div class="map-canvas full" data-map-canvas tabindex="0"><div class="map-canvas-in" style="transform:translate(${String(ui.panX)}px,${String(ui.panY)}px) scale(${String(ui.zoom)})">${fullGraphSvg(m, sheet.graph, focus, { grouped: ui.grouped, ...(ui.graphSel ? { selection: ui.graphSel } : {}) })}</div></div>`
      : integrationPath(m, ui, sheet);
  const edges = ui.graphMode === 'full' ? sheet.graph.edges : sheet.path.edges;
  const count = (c: string): number => edges.filter((e) => e.confidence === c).length;
  return `<div class="map-trace${ui.fullscreen ? ' full' : ''}" data-map-trace><div class="map-gtitle"><h3>${esc(m.a.tabs.trace)} · <b>${esc(sheet.api.name)}</b></h3>${toolbar}</div>${content}<div class="map-legend2"><span class="lg c-confirmed">${icon('check')}${esc(m.g.legendConfirmed(count('CONFIRMED')))}</span><span class="lg c-probable">${icon('alert')}${esc(m.g.legendProbable(count('PROBABLE')))}</span><span class="lg c-unknown"><i></i>${esc(m.g.legendUnknown(count('UNKNOWN')))}</span><span class="lg flow"><i></i>${esc(m.g.legendFlow)}</span></div></div>`;
}

function featuresTable(m: MapStrings, h: ApiViewHelpers, sheet: ApiSheet): string {
  if (sheet.features.length === 0) return `<p class="mu">${esc(m.a.noFeatures)}</p>`;
  const rows = sheet.features
    .map(
      (f) =>
        `<tr><td><button class="lnk" data-action="map-feature" data-feature="${esc(f.id)}" title="${esc(f.via.join(' ← '))}">${icon('cube')} ${esc(f.name)}</button></td><td>${esc(f.module ?? '—')}</td><td>${f.usage.map((u) => `<span class="map-tag">${esc(u)}</span>`).join(' ') || '<span class="mu">—</span>'}</td><td>${h.conf(f.confidence)}</td></tr>`,
    )
    .join('');
  return `<div class="tbl-w"><table class="tbl map-tbl map-atbl"><thead><tr><th>${esc(m.a.colFeature)}</th><th>${esc(m.a.colModule)}</th><th>${esc(m.a.colUsage)}</th><th>${esc(m.a.colStatus)}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function scenariosTable(m: MapStrings, h: ApiViewHelpers, sheet: ApiSheet): string {
  if (sheet.scenarios.length === 0) return `<p class="mu">${esc(m.a.noScenarios)}</p>`;
  const rows = sheet.scenarios
    .map((s) => {
      const view = h.scenarios.find((v) => v.name === s.scenario);
      const key = s.verified ? 'verified' : s.executed ? 'executed' : 'associated';
      const tone = s.verified ? 'VERIFIED' : s.executed ? 'EXECUTED' : 'ASSOCIATED';
      const verdict = s.lastRun ? h.chip(s.lastRun.verdict, s.lastRun.verdict) : '';
      return `<tr><td><button class="lnk" data-action="map-open-scenario" data-scenario="${esc(s.scenario)}">${icon('play')} ${esc(s.scenario)}</button></td><td>${esc(view ? (view.format === 'gherkin' ? 'Gherkin' : 'YAML') : '—')}</td><td>${h.chip(tone, m.p.scenarioState[key] ?? key)} ${verdict}</td><td>${s.lastRun?.at ? esc(h.date(s.lastRun.at)) : `<span class="mu">${esc(m.notPlayed)}</span>`}</td></tr>`;
    })
    .join('');
  return `<div class="tbl-w"><table class="tbl map-tbl map-atbl"><thead><tr><th>${esc(m.a.colScenario)}</th><th>${esc(m.a.colType)}</th><th>${esc(m.a.colStatus)}</th><th>${esc(m.a.colLastRun)}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function impactsPane(m: MapStrings, ui: CartographyUi, h: ApiViewHelpers, sheet: ApiSheet): string {
  const block = (title: string, part: ApiSheet['impact']['demonstrated'], tone: string): string =>
    `<section class="map-aimp ${tone}"><h4>${esc(title)}</h4><dl class="map-dl map-adl"><dt>${esc(m.a.impactFeatures)}</dt><dd>${part.features.map((f) => `<span class="map-tag ${tone}">${esc(f)}</span>`).join(' ') || `<span class="mu">${esc(m.a.none)}</span>`}</dd><dt>${esc(m.a.impactScenarios)}</dt><dd>${part.scenarios.map((s) => `<span class="map-tag ${tone}">${esc(s)}</span>`).join(' ') || `<span class="mu">${esc(m.a.none)}</span>`}</dd><dt>${esc(m.a.impactComponents)}</dt><dd>${part.components.map((c) => `<span class="map-tag ${tone}">${esc(c)}</span>`).join(' ') || `<span class="mu">${esc(m.a.none)}</span>`}</dd><dt>${esc(m.a.impactDtos)}</dt><dd>${part.dtos.map((d) => `<span class="map-tag ${tone}">${esc(d)}</span>`).join(' ') || `<span class="mu">${esc(m.a.none)}</span>`}</dd></dl></section>`;
  const scenarios = [
    ...new Set([...sheet.impact.demonstrated.scenarios, ...sheet.impact.potential.scenarios]),
  ];
  const launch =
    h.canRun && scenarios.length > 0
      ? `<details class="map-replay"><summary>${esc(m.p.prepareReplay)}</summary><ul class="map-imp-l">${scenarios.map((s) => `<li><label class="map-pickrow"><input type="checkbox" data-map="api-pick" data-scenario="${esc(s)}" ${ui.apiPicked.includes(s) ? 'checked' : ''}> ${esc(s)}</label></li>`).join('')}</ul><div class="map-filters"><label class="pick">${esc(m.environment)} <select data-map="impact-env"><option value="">${esc(m.noEnvironment)}</option>${h.environments.map((e) => `<option value="${esc(e.id)}" ${e.id === ui.impactEnv ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></label><button class="btn small primary" data-action="map-api-launch" ${ui.apiPicked.length === 0 || ui.launching ? 'disabled' : ''}>${icon('play')}<span>${esc(m.launchSelection(ui.apiPicked.length))}</span></button></div><p class="mu small">${esc(m.selectionNote)}</p></details>`
      : '';
  return `<h4>${esc(m.a.impactTitle)}</h4><div class="map-aimps">${block(m.a.impactDemonstrated, sheet.impact.demonstrated, 'ok')}${block(m.a.impactPotential, sheet.impact.potential, 'warn')}</div>${launch}`;
}

function centerCard(m: MapStrings, ui: CartographyUi, h: ApiViewHelpers): string {
  if (!ui.api) return `<section class="card map-acenter"><p class="mu">${esc(m.a.pick)}</p></section>`;
  const sheet = ui.apiSheet;
  if (!sheet || sheet.api.id !== ui.api)
    return `<section class="card map-acenter">${h.paneError(ui.errors.apiSheet)}${ui.errors.apiSheet ? '' : h.spinner()}</section>`;
  const api = sheet.api;
  const impacts = sheet.impact.demonstrated.features.length + sheet.impact.potential.features.length;
  const tabs: [ApiTab, string][] = [
    ['summary', m.a.tabs.summary],
    ['endpoints', m.a.tabs.endpoints(api.endpoints.length)],
    ['trace', m.a.tabs.trace],
    ['features', m.a.tabs.features(sheet.features.length)],
    ['scenarios', m.a.tabs.scenarios(sheet.scenarios.length)],
    ['impacts', m.a.tabs.impacts(impacts)],
  ];
  let body: string;
  if (ui.apiTab === 'endpoints') body = endpointsPane(m, h, sheet);
  else if (ui.apiTab === 'trace') body = tracePane(m, ui, sheet);
  else if (ui.apiTab === 'features') body = featuresTable(m, h, sheet);
  else if (ui.apiTab === 'scenarios') body = scenariosTable(m, h, sheet);
  else if (ui.apiTab === 'impacts') body = impactsPane(m, ui, h, sheet);
  else
    body = `<h3 class="map-ah3">${icon('traceability')}<span>${esc(m.a.pathTitle)}</span></h3>${integrationPath(m, ui, sheet)}<div class="map-acards">${generalCard(m, ui, h, sheet)}${contractCard(m, h, sheet)}</div>`;
  return `<section class="card map-acenter" aria-label="${esc(api.name)}"><div class="map-ahead"><span class="map-ahead-i ${SCOPE_TONE[api.scope] ?? ''}">${icon(SCOPE_ICON[api.scope] ?? 'code')}</span><div><h2>${esc(api.name)} ${scopeBadge(m, api)} ${statusBadge(m, h, api.status)}</h2><p class="mu small">${esc(describe(m, api))}</p></div></div><div class="tabs map-sheet-t" role="tablist">${tabs.map(([id, label]) => `<button role="tab" data-action="map-api-tab" data-tab="${id}" aria-selected="${String(ui.apiTab === id)}">${esc(label)}</button>`).join('')}</div><div class="map-center-b">${body}</div></section>`;
}

function rightColumn(m: MapStrings, ui: CartographyUi, h: ApiViewHelpers): string {
  const sheet = ui.apiSheet;
  if (!sheet || sheet.api.id !== ui.api) return '<aside class="map-right"></aside>';
  const api = sheet.api;
  const classify =
    h.canDecide && api.scope === 'UNCLASSIFIED'
      ? `<dt>${esc(m.a.classify)}</dt><dd><button class="btn small" data-action="map-api-classify" data-value="INTERNAL">${esc(m.a.classifyInternal)}</button><button class="btn small" data-action="map-api-classify" data-value="EXTERNAL">${esc(m.a.classifyExternal)}</button></dd>`
      : '';
  const details = `<section class="card map-adet"><h2>${icon('info')}<span>${esc(m.a.details)}</span></h2><dl class="map-dl map-adl"><dt>${esc(m.a.endpointsCount)}</dt><dd>${String(api.endpoints.length)}</dd><dt>${esc(m.a.featuresCount)}</dt><dd>${String(sheet.features.length)}</dd><dt>${esc(m.a.scenariosCount)}</dt><dd>${String(sheet.scenarios.length)}</dd><dt>${esc(m.a.fieldsCount)}</dt><dd>${String(api.fields.length)}</dd><dt>${esc(m.a.statusLabel)}</dt><dd>${statusBadge(m, h, api.status)} ${h.conf(api.confidence)}</dd><dt>${esc(m.a.scope)}</dt><dd>${scopeBadge(m, { scope: api.scope })}</dd><dt>${esc(m.a.criticality)}</dt><dd>${h.chip(sheet.criticality.level === 'HIGH' ? 'NOT_COVERED' : sheet.criticality.level === 'MEDIUM' ? 'PROBABLE' : 'CANDIDATE', m.a.criticalityLevel[sheet.criticality.level] ?? sheet.criticality.level)} <span class="map-help" title="${esc(sheet.criticality.reason)}">${icon('info')}</span></dd><dt>${esc(m.a.availability)}</dt><dd class="mu small">${esc(m.a.availabilityNote)}</dd>${classify}</dl></section>`;
  const sent = api.fields.filter((f) => f.direction === 'OUT');
  const received = api.fields.filter((f) => f.direction === 'IN');
  const row = (f: ApiService['fields'][number]): string =>
    `<tr><td><span title="${esc(`${f.container}.${f.name}${f.type ? ` : ${f.type}` : ''}${f.required ? ' · obligatoire' : ''}`)}">${esc(f.name)}</span>${f.required ? ' <small class="warn-t">*</small>' : ''}<small class="map-afc mono mu">${esc(f.container)}</small></td><td><span class="map-dir ${f.direction === 'OUT' ? 'out' : 'in'}">${f.direction === 'OUT' ? '→' : '←'} ${esc(f.direction === 'OUT' ? m.a.dirOut : m.a.dirIn)}</span></td></tr>`;
  const part = (title: string, list: ApiService['fields']): string =>
    list.length
      ? `<tr class="map-apart"><th colspan="2">${esc(title)}</th></tr>${list.map(row).join('')}`
      : '';
  const fields = `<section class="card map-afields"><h2>${icon('data')}<span>${esc(m.a.fields(api.fields.length))}</span></h2>${
    api.fields.length
      ? `<div class="tbl-w"><table class="tbl map-tbl map-atbl"><thead><tr><th>${esc(m.a.field)}</th><th>${esc(m.a.direction)}</th></tr></thead><tbody>${part(m.a.requestPart, sent)}${part(m.a.responsePart, received)}</tbody></table></div>`
      : `<p class="mu small">${esc(m.a.noFields)}</p>`
  }</section>`;
  return `<aside class="map-right">${details}${fields}</aside>`;
}

/** L'onglet entier : catalogue, fiche, détails ; puis fonctionnalités et scénarios en bas. */
export function apisTab(m: MapStrings, ui: CartographyUi, h: ApiViewHelpers): string {
  const sheet = ui.apiSheet && ui.apiSheet.api.id === ui.api ? ui.apiSheet : undefined;
  const bottom = sheet
    ? `<div class="map-bottom two"><section class="card map-afeat"><h2>${icon('cube')}<span>${esc(m.a.featuresTitle(sheet.features.length))}</span></h2>${featuresTable(m, h, sheet)}</section><section class="card map-ascen"><h2>${icon('play')}<span>${esc(m.a.scenariosTitle(sheet.scenarios.length))}</span></h2>${scenariosTable(m, h, sheet)}</section></div>`
    : '';
  return `<div class="map-explorer map-apis">${catalogCard(m, ui, h)}${centerCard(m, ui, h)}${rightColumn(m, ui, h)}</div>${bottom}`;
}

/** Les indicateurs de l'onglet, calculés par le serveur sur le catalogue réel. */
export function apiKpis(m: MapStrings, ui: CartographyUi): string {
  const k = ui.apis?.kpis;
  const tile = (name: string, value: number | undefined, label: string, tone = ''): string =>
    `<article class="map-kpi${tone}">${icon(name)}<span><b>${value === undefined ? '—' : String(value)}</b><small>${esc(label)}</small></span></article>`;
  return `<section class="map-kpis" aria-label="${esc(m.a.title)}">${tile('layers', k?.apis, m.a.kpi.apis)}${tile('code', k?.internal, m.a.kpi.internal)}${tile('cloud', k?.external, m.a.kpi.external, ' violet')}${tile('data', k?.endpoints, m.a.kpi.endpoints)}${tile('link', k?.features, m.a.kpi.features)}${tile('play', k?.scenarios, m.a.kpi.scenarios)}</section>`;
}

export const APIS_CSS = `
.map-scopes{display:flex;flex-wrap:wrap;gap:6px}
.map-scope{border:1px solid var(--qa-color-border);background:var(--qa-color-surface);border-radius:999px;padding:3px 10px;font-size:12px;font-weight:600;color:var(--qa-color-text);cursor:pointer}
.map-scope.on{background:var(--qa-color-primary);border-color:var(--qa-color-primary);color:#fff}
.map-scope:focus-visible,.map-aitem:focus-visible{outline:2px solid var(--qa-color-primary);outline-offset:2px}
.map-aitem{display:grid;grid-template-columns:auto minmax(0,1fr);grid-template-areas:"i n" "b b";gap:4px 8px;align-items:start;width:100%;text-align:left;padding:9px 10px;border:1px solid var(--qa-color-border);border-radius:10px;background:var(--qa-color-surface);color:inherit;cursor:pointer}
.map-aitem.sel{border-color:#7c5cd6;background:color-mix(in srgb,#7c5cd6 8%,var(--qa-color-surface));box-shadow:0 0 0 1px #7c5cd6}
.map-aitem.sel.int{border-color:var(--qa-color-primary);background:var(--qa-color-primary-soft-2);box-shadow:0 0 0 1px var(--qa-color-primary)}
.map-aitem-i{grid-area:i}
.map-aitem-i .ico{width:20px;height:20px;color:var(--qa-color-primary)}
.map-aitem.ext .map-aitem-i .ico{color:#7c5cd6}
.map-aitem.unk .map-aitem-i .ico{color:var(--qa-color-warning)}
.map-aitem-n{grid-area:n;display:flex;flex-direction:column;min-width:0}
.map-aitem-n b{font-size:13px;overflow-wrap:anywhere}
.map-aitem-n small{font-size:11px;color:var(--qa-color-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.map-aitem-b{grid-area:b;display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end}
.map-aitem-b .pill{font-size:10.5px;padding:2px 7px}
.map-abadge{display:inline-flex;align-items:center;border-radius:6px;padding:2px 7px;font-size:10.5px;font-weight:600;white-space:nowrap}
.map-abadge.int{background:color-mix(in srgb,#2f80c8 14%,var(--qa-color-surface));color:color-mix(in srgb,#2f80c8 80%,var(--qa-color-text))}
.map-abadge.ext{background:color-mix(in srgb,#7c5cd6 14%,var(--qa-color-surface));color:color-mix(in srgb,#7c5cd6 85%,var(--qa-color-text))}
.map-abadge.unk{background:var(--qa-color-warning-soft);color:var(--qa-color-text)}
.map-ahead{display:flex;gap:12px;align-items:flex-start;margin-bottom:6px}
.map-ahead h2{margin:0;font-size:17px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.map-ahead p{margin:2px 0 0}
.map-ahead-i .ico{width:30px;height:30px;color:var(--qa-color-primary)}
.map-ahead-i.ext .ico{color:#7c5cd6}
.map-ahead-i.unk .ico{color:var(--qa-color-warning)}
.map-ah3{display:flex;gap:6px;align-items:center;font-size:14px;margin:4px 0}
.map-ah3 .ico{color:var(--qa-color-primary);width:16px;height:16px}
.map-acards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.map-acards .card{padding:12px;box-shadow:none}
.map-acards h3{display:flex;gap:6px;align-items:center;font-size:13.5px;margin:0 0 8px}
.map-acards h3 .ico{width:16px;height:16px;color:var(--qa-color-primary)}
.map-adl{grid-template-columns:auto 1fr;gap:5px 12px;font-size:12.5px;margin:0}
.map-adl dt{font-weight:600}
.map-adl dd{margin:0;display:flex;flex-wrap:wrap;gap:4px;align-items:center;min-width:0;overflow-wrap:anywhere}
.map-adl .btn.icon-only{width:24px;height:24px;min-height:24px;padding:0}
.map-arename{display:flex;gap:6px;flex-wrap:wrap;align-items:center;width:100%}
.map-arename input{flex:1 1 140px;min-width:0}
.map-pcard.l-external{--lane:color-mix(in srgb,#7c5cd6 14%,var(--qa-color-surface));--lane-b:#7c5cd6}
.map-pcard.l-unclassified{--lane:var(--qa-color-warning-soft);--lane-b:var(--qa-color-warning)}
.map-pcard.l-other{--lane:var(--qa-color-surface-2);--lane-b:var(--qa-color-border-strong)}
.map-dir{font-size:11.5px;font-weight:600;border-radius:6px;padding:1px 7px;white-space:nowrap}
.map-dir.out{background:var(--qa-color-success-soft);color:var(--qa-color-primary-2)}
.map-dir.in{background:color-mix(in srgb,#2f80c8 14%,var(--qa-color-surface));color:color-mix(in srgb,#2f80c8 80%,var(--qa-color-text))}
.map-apart th{background:var(--qa-color-surface-2);font-size:11px;text-transform:none;letter-spacing:0}
.map-atbl{min-width:0}
.map-atbl td,.map-atbl th{font-size:12px;padding:6px 7px;white-space:normal}
.map-verb2{font-family:var(--qa-font-family-mono);font-size:11px;font-weight:700;color:var(--qa-color-primary-2)}
.map-aimps{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px}
.map-aimp{border:1px solid var(--qa-color-border);border-radius:10px;padding:10px}
.map-aimp h4{margin:0 0 6px}
.map-kpi.violet .ico{color:#7c5cd6}
.map-afc{display:block;font-size:10px}
.map-acat .map-filters{flex-wrap:nowrap}
.map-acat .map-search{flex:1 1 auto;min-width:0}
.map-acat .map-search input{min-width:0;width:100%}
.map-acenter .map-sheet-t{flex-wrap:nowrap;overflow-x:auto;gap:2px}
.map-acenter .map-sheet-t button{padding:0 8px;font-size:12.5px;white-space:nowrap;flex:none}
.map-pcard .map-pc-h small{overflow-wrap:anywhere}
.map-adl dd code{white-space:normal;overflow-wrap:anywhere}
`;
