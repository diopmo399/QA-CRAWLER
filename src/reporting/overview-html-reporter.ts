import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExplorationResult } from '../model/exploration-result.js';
import type { FlowStatus } from '../model/flow-run.js';
import { esc } from './html-common.js';
import { relativeTo } from './html-reporter.js';
import type { ReportLanguage } from './i18n.js';
import {
  buildOverviewModel,
  type OverviewDataEntry,
  type OverviewFlow,
  type OverviewModel,
  type OverviewStep,
  type OverviewTone,
} from './overview-model.js';
import type { Reporter } from './reporter.js';

/**
 * reports/overview.html — la VUE D'ENSEMBLE d'un run : indicateurs, parcours détecté (étapes et
 * réutilisations de données), détails du run, timeline des actions et lignée des données de test.
 * Une page autonome : aucune ressource externe, un peu de JavaScript seulement pour les filtres,
 * le choix du flow, le thème clair / sombre et les liens du parcours (tout reste lisible sans).
 */
export class OverviewHtmlReporter implements Reporter {
  readonly format = 'overview-html';

  constructor(
    private readonly directory: string,
    private readonly fileName = 'overview.html',
    private readonly language: ReportLanguage = 'en',
  ) {}

  async write(result: ExplorationResult): Promise<string> {
    const target = path.join(this.directory, this.fileName);
    await writeFile(
      target,
      renderOverviewHtml(result, (file) => relativeTo(this.directory, file), this.language),
      'utf8',
    );
    return target;
  }
}

interface OverviewTexts {
  title: string;
  tagline: string;
  subtitle: string;
  search: string;
  home: string;
  execution: string;
  intelligence: string;
  files: string;
  flows: string;
  timeline: string;
  fullReport: string;
  runAnalysis: string;
  testData: string;
  flowGraph: string;
  engineLog: string;
  explorer: string;
  aiOff: string;
  flow: string;
  issues: string;
  themeDark: string;
  themeLight: string;
  kpi: {
    validated: string;
    of: string;
    interpreted: string;
    interpretedHint: string;
    notInterpreted: string;
    noIntent: string;
    duration: string;
    states: string;
    executed: string;
    failedActions: string;
  };
  journey: string;
  seeDetail: string;
  legend: { valid: string; warning: string; failed: string; unknown: string; current: string };
  tone: Record<OverviewTone, string>;
  generates: string;
  reuses: string;
  noFlow: string;
  noFlowHint: string;
  details: string;
  rows: {
    id: string;
    status: string;
    duration: string;
    actions: string;
    validated: string;
    notInterpreted: string;
    mode: string;
    application: string;
    target: string;
    date: string;
    confidence: string;
    proof: string;
    drift: string;
  };
  fullReportButton: string;
  tabs: { all: string; valid: string; warning: string; unknown: string; failed: string };
  more: (count: number) => string;
  seeAll: string;
  seeLess: string;
  noRow: string;
  generatedValue: string;
  hiddenValue: string;
  usedIn: string;
  copy: string;
  copied: string;
  step: string;
  description: string;
  interpretation: string;
  intent: string;
  requests: string;
  reason: string;
  healed: string;
  screenshot: string;
  view: string;
  lineage: string;
  seeAllData: string;
  usedInSteps: (count: number) => string;
  roles: { SOURCE: string; REUSE: string; CITATION: string };
  generated: string;
  dataFlow: string;
  generation: string;
  noData: string;
  status: Record<FlowStatus, string>;
}

const FR: OverviewTexts = {
  title: "Vue d'ensemble",
  tagline: 'Smart QA for modern web apps',
  subtitle: "Suivez l'exécution, analysez les résultats et explorez l'intelligence derrière chaque action.",
  search: 'Rechercher une étape, une donnée…',
  home: 'Accueil',
  execution: 'EXÉCUTION',
  intelligence: 'INTELLIGENCE',
  files: 'FICHIERS',
  flows: 'Flows',
  timeline: 'Timeline',
  fullReport: 'Rapport détaillé',
  runAnalysis: 'Analyse du run',
  testData: 'Test Data',
  flowGraph: 'Graphe des flows',
  engineLog: 'Journal moteur',
  explorer: 'Explorateur intelligent de parcours web',
  aiOff: 'LLM (optionnel)',
  flow: 'Flow',
  issues: 'Anomalies',
  themeDark: 'Thème sombre',
  themeLight: 'Thème clair',
  kpi: {
    validated: 'Actions validées',
    of: 'sur',
    interpreted: 'Interprétées',
    interpretedHint: '(intention métier)',
    notInterpreted: 'Non interprétées',
    noIntent: 'intention non disponible pour ce flow',
    duration: "Durée d'exécution",
    states: 'États découverts',
    executed: 'Actions exécutées',
    failedActions: 'Actions en échec',
  },
  journey: 'Parcours détecté',
  seeDetail: 'Voir le détail',
  legend: {
    valid: 'Validé',
    warning: 'Avertissement',
    failed: 'Échec',
    unknown: 'Inconnu',
    current: 'Étape actuelle',
  },
  tone: {
    valid: 'Validé',
    warning: 'Partiel',
    failed: 'Échec',
    unknown: 'Inconnu',
    skipped: 'Ignoré',
    manual: 'Manuel',
  },
  generates: 'Génère une valeur',
  reuses: 'Réutilise la même valeur',
  noFlow: 'Aucun flow imposé dans ce run',
  noFlowHint: "L'exploration autonome est détaillée dans le rapport complet et le graphe des flows.",
  details: 'Détails du run',
  rows: {
    id: 'ID',
    status: 'Statut',
    duration: 'Durée',
    actions: 'Actions',
    validated: 'Validées',
    notInterpreted: 'Non interprétées',
    mode: 'Mode',
    application: 'Application',
    target: 'Environnement',
    date: 'Date',
    confidence: 'Confiance',
    proof: 'Preuve métier',
    drift: 'Dérive',
  },
  fullReportButton: 'Voir le rapport complet',
  tabs: { all: 'Tous', valid: 'Validées', warning: 'Avertissements', unknown: 'Inconnues', failed: 'Échecs' },
  more: (count) => `Et ${count} autre${count > 1 ? 's' : ''} étape${count > 1 ? 's' : ''}`,
  seeAll: 'Voir toutes les étapes',
  seeLess: 'Réduire',
  noRow: 'Aucune étape ne correspond.',
  generatedValue: 'Valeur générée',
  hiddenValue: 'Valeur non publiée (enregistrée, saisie ou sensible)',
  usedIn: 'Utilisée dans',
  copy: 'Copier la valeur',
  copied: 'Copié',
  step: 'Étape',
  description: 'Étape YAML',
  interpretation: 'Interprétation',
  intent: 'Intention',
  requests: 'Requêtes',
  reason: 'Raison',
  healed: 'Cible guérie',
  screenshot: 'Capture',
  view: 'voir',
  lineage: 'Test Data & Data Lineage',
  seeAllData: 'Voir tout',
  usedInSteps: (count) => `Utilisée dans ${count} étape${count > 1 ? 's' : ''}`,
  roles: { SOURCE: 'Source', REUSE: 'Réutilisation', CITATION: 'Citation' },
  generated: 'Générée',
  dataFlow: 'Flux de données',
  generation: 'Génération',
  noData: 'Aucune donnée de test dans ce flow.',
  status: { PASSED: 'Terminé', FAILED: 'Échec', BLOCKED: 'Bloqué', SKIPPED: 'Ignoré', MANUAL: 'Manuel' },
};

const EN: OverviewTexts = {
  ...FR,
  title: 'Overview',
  subtitle: 'Follow the run, analyse the results and explore the intelligence behind every action.',
  search: 'Search a step, a data key…',
  home: 'Home',
  execution: 'EXECUTION',
  files: 'FILES',
  fullReport: 'Full report',
  runAnalysis: 'Run analysis',
  flowGraph: 'Flow graph',
  engineLog: 'Engine log',
  explorer: 'Intelligent web journey explorer',
  aiOff: 'LLM (optional)',
  issues: 'Issues',
  themeDark: 'Dark theme',
  themeLight: 'Light theme',
  kpi: {
    validated: 'Validated actions',
    of: 'of',
    interpreted: 'Interpreted',
    interpretedHint: '(business intent)',
    notInterpreted: 'Not interpreted',
    noIntent: 'intent not available for this flow',
    duration: 'Run duration',
    states: 'States discovered',
    executed: 'Actions executed',
    failedActions: 'Failed actions',
  },
  journey: 'Detected journey',
  seeDetail: 'See details',
  legend: {
    valid: 'Validated',
    warning: 'Warning',
    failed: 'Failed',
    unknown: 'Unknown',
    current: 'Current step',
  },
  tone: {
    valid: 'Validated',
    warning: 'Partial',
    failed: 'Failed',
    unknown: 'Unknown',
    skipped: 'Skipped',
    manual: 'Manual',
  },
  generates: 'Generates a value',
  reuses: 'Reuses the same value',
  noFlow: 'No imposed flow in this run',
  noFlowHint: 'The autonomous exploration is detailed in the full report and the flow graph.',
  details: 'Run details',
  rows: {
    id: 'ID',
    status: 'Status',
    duration: 'Duration',
    actions: 'Actions',
    validated: 'Validated',
    notInterpreted: 'Not interpreted',
    mode: 'Mode',
    application: 'Application',
    target: 'Environment',
    date: 'Date',
    confidence: 'Confidence',
    proof: 'Business proof',
    drift: 'Drift',
  },
  fullReportButton: 'See the full report',
  tabs: { all: 'All', valid: 'Validated', warning: 'Warnings', unknown: 'Unknown', failed: 'Failed' },
  more: (count) => `And ${count} more step${count > 1 ? 's' : ''}`,
  seeAll: 'See all steps',
  seeLess: 'Show less',
  noRow: 'No step matches.',
  generatedValue: 'Generated value',
  hiddenValue: 'Value not published (recorded, typed or sensitive)',
  usedIn: 'Used in',
  copy: 'Copy the value',
  copied: 'Copied',
  step: 'Step',
  description: 'YAML step',
  interpretation: 'Interpretation',
  intent: 'Intent',
  requests: 'Requests',
  reason: 'Reason',
  healed: 'Healed target',
  screenshot: 'Screenshot',
  view: 'view',
  seeAllData: 'See all',
  usedInSteps: (count) => `Used in ${count} step${count > 1 ? 's' : ''}`,
  roles: { SOURCE: 'Source', REUSE: 'Reuse', CITATION: 'Citation' },
  generated: 'Generated',
  dataFlow: 'Data flow',
  generation: 'Generation',
  noData: 'No test data in this flow.',
  status: { PASSED: 'Completed', FAILED: 'Failed', BLOCKED: 'Blocked', SKIPPED: 'Skipped', MANUAL: 'Manual' },
};

/** Les étapes visibles dans la timeline avant « Voir toutes les étapes ». */
const TIMELINE_VISIBLE = 6;

export function renderOverviewHtml(
  result: ExplorationResult,
  href: (file: string) => string = (file) => file,
  language: ReportLanguage = 'en',
): string {
  const t = language === 'fr' ? FR : EN;
  const model = buildOverviewModel(result);
  const link = (file: string | undefined): string | undefined => (file ? href(file) : undefined);
  const links = {
    html: link(result.artifacts.html),
    flowGraphHtml: link(result.artifacts.flowGraphHtml),
    runAnalysis: link(result.artifacts.runAnalysis),
    json: link(result.artifacts.json),
    flowGraph: link(result.artifacts.flowGraph),
    engineLog: link(result.artifacts.engineLog),
  };
  const shot = (file: string): string => href(file);

  const views =
    model.flows.length > 0
      ? model.flows.map((flow, index) => flowView(flow, index, model, t, links.html, shot)).join('\n')
      : explorationView(model, t);

  return `<!doctype html>
<html lang="${language}" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QA-CRAWLER — ${esc(t.title)} — ${esc(model.mission)}</title>
<script>try{var s=localStorage.getItem('qa-crawler-theme');if(s==='dark'||s==='light')document.documentElement.dataset.theme=s;}catch(e){}</script>
<style>${CSS}</style>
</head>
<body>
<div class="app" id="top">
${header(model, t, links.html)}
<div class="shell">
${sidebar(model, t, links)}
<main class="main">
  <div class="page-head">
    <div>
      <h1>${esc(t.title)}</h1>
      <p class="lead">${esc(t.subtitle)}</p>
    </div>
    <div class="page-tools">
      ${
        model.flows.length > 1
          ? `<label class="select"><span class="sr">${esc(t.flow)}</span><select id="flow-select">${model.flows
              .map((flow, index) => `<option value="${index}">${esc(flow.name)}</option>`)
              .join('')}</select>${icon('chevron')}</label>`
          : model.flows[0]
            ? `<span class="select static">${esc(model.flows[0].name)}</span>`
            : ''
      }
      <div class="run-chip">
        <strong>${esc(shortRunId(model.runId))}</strong>
        ${runStatusPill(model, t)}
        <span class="muted" data-datetime="${esc(model.startedAt)}">${esc(model.startedAt.slice(0, 16).replace('T', ' '))}</span>
      </div>
    </div>
  </div>
${views}
</main>
</div>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

function header(model: OverviewModel, t: OverviewTexts, fullReport: string | undefined): string {
  const issues = `${icon('bell')}${model.issues > 0 ? `<span class="badge-count">${model.issues > 99 ? '99+' : model.issues}</span>` : ''}`;
  return `<header class="topbar">
  <div class="brand">${logo()}<div><div class="brand-name">QA-CRAWLER</div><div class="brand-tag">${esc(t.tagline)}</div></div></div>
  <label class="search">${icon('search')}<span class="sr">${esc(t.search)}</span><input id="search" type="search" placeholder="${esc(t.search)}" autocomplete="off"><kbd>/</kbd></label>
  <div class="top-actions">
    <span class="mode-chip"><span class="dot"></span>${esc(capitalize(model.mode))}</span>
    ${
      fullReport
        ? `<a class="icon-button" href="${esc(fullReport)}" aria-label="${esc(t.issues)} (${model.issues})" title="${esc(t.issues)}">${issues}</a>`
        : `<span class="icon-button" role="img" aria-label="${esc(t.issues)} (${model.issues})">${issues}</span>`
    }
    <button class="icon-button" id="theme-toggle" type="button" aria-label="${esc(t.themeDark)}" data-dark="${esc(t.themeDark)}" data-light="${esc(t.themeLight)}">${icon('moon', 'only-light')}${icon('sun', 'only-dark')}</button>
    <span class="mission"><span class="avatar" aria-hidden="true">${esc(initials(model.mission))}</span><span><span class="mission-name">${esc(model.mission)}</span><span class="mission-host">${esc(host(model.baseUrl))}</span></span></span>
  </div>
</header>`;
}

function sidebar(
  model: OverviewModel,
  t: OverviewTexts,
  links: Record<
    'html' | 'flowGraphHtml' | 'runAnalysis' | 'json' | 'flowGraph' | 'engineLog',
    string | undefined
  >,
): string {
  const item = (
    target: string | undefined,
    iconName: string,
    label: string,
    extra = '',
    active = false,
  ): string =>
    target
      ? `<a class="nav-item${active ? ' active' : ''}" href="${esc(target)}"${active ? ' aria-current="page"' : ''}>${icon(iconName)}<span>${esc(label)}</span>${extra}</a>`
      : '';
  const files = [
    item(links.json, 'file', 'result.json'),
    item(links.flowGraph, 'file', 'flow-graph.json'),
    item(links.engineLog, 'file', t.engineLog),
  ].join('');
  const stack = [
    'Playwright',
    'Chromium',
    model.node ? `Node ${model.node}` : '',
    model.ai ?? t.aiOff,
  ].filter(Boolean);
  return `<nav class="sidebar" aria-label="QA-CRAWLER">
  ${item('#top', 'home', t.home, '', true)}
  <div class="nav-group">${esc(t.execution)}</div>
  ${item('#journey', 'flows', t.flows, model.flows.length > 0 ? `<span class="nav-count">${model.flows.length}</span>` : '')}
  ${item('#timeline', 'list', t.timeline)}
  ${item(links.html, 'report', t.fullReport)}
  <div class="nav-group">${esc(t.intelligence)}</div>
  ${item(links.runAnalysis, 'chart', t.runAnalysis)}
  ${item('#lineage', 'database', t.testData)}
  ${item(links.flowGraphHtml, 'graph', t.flowGraph)}
  ${files ? `<div class="nav-group">${esc(t.files)}</div>${files}` : ''}
  <div class="side-foot"><div class="side-card">
    <div class="side-card-head">${logo(22)}<div><strong>QA-CRAWLER</strong><div class="muted small">${model.version ? `v${esc(model.version)}` : ''}</div></div></div>
    <p class="muted small">${esc(t.explorer)}</p>
    <svg class="wave" viewBox="0 0 200 50" aria-hidden="true"><path d="M0 38 C40 30 60 46 100 36 S160 10 200 6" fill="none" stroke="var(--purple)" stroke-width="2"/><path d="M0 44 C50 38 80 48 120 40 S170 26 200 24" fill="none" stroke="var(--blue)" stroke-width="1.5" opacity=".7"/></svg>
    <ul class="stack">${stack.map((entry) => `<li>${esc(entry)}</li>`).join('')}</ul>
  </div></div>
</nav>`;
}

function flowView(
  flow: OverviewFlow,
  index: number,
  model: OverviewModel,
  t: OverviewTexts,
  fullReport: string | undefined,
  shot: (file: string) => string,
): string {
  const k = flow.kpis;
  const percent = k.actions > 0 ? Math.round((k.validated / k.actions) * 100) : 0;
  const unknownPercent = k.actions > 0 ? Math.round((k.notInterpreted / k.actions) * 100) : 0;
  const kpis = `<div class="kpis">
    ${kpi('ok', icon('check-bold'), String(k.validated), t.kpi.validated, `${t.kpi.of} ${k.actions}`, `<div class="meter"><div class="bar"><span style="width:${percent}%"></span></div><b>${percent}%</b></div>`)}
    ${kpi('purple', icon('bulb'), k.intentAvailable ? String(k.interpreted) : '—', t.kpi.interpreted, k.intentAvailable ? t.kpi.interpretedHint : t.kpi.noIntent)}
    ${kpi('warn', icon('alert'), k.intentAvailable ? String(k.notInterpreted) : '—', t.kpi.notInterpreted, k.intentAvailable ? '(UNKNOWN)' : t.kpi.noIntent)}
    ${kpi('blue', icon('clock'), formatDuration(k.durationMs), t.kpi.duration, '', sparkline(k.durations))}
  </div>`;

  const legend = `<div class="legend">
      <span><i class="lg valid"></i>${esc(t.legend.valid)}</span>
      <span><i class="lg warning"></i>${esc(t.legend.warning)}</span>
      ${k.failed > 0 ? `<span><i class="lg failed"></i>${esc(t.legend.failed)}</span>` : ''}
      <span><i class="lg unknown"></i>${esc(t.legend.unknown)}</span>
      <span><i class="lg current"></i>${esc(t.legend.current)}</span>
    </div>`;

  const journey = `<section class="card journey-card" id="journey" aria-labelledby="journey-${index}">
    <div class="card-head">
      <h2 id="journey-${index}">${icon('target')}${esc(t.journey)}</h2>
      ${legend}
      ${fullReport ? `<a class="ghost-button" href="${esc(fullReport)}">${esc(t.seeDetail)} →</a>` : ''}
    </div>
    ${flow.description ? `<p class="muted small flow-desc">${esc(flow.description)}</p>` : ''}
    <div class="journey" data-links='${esc(JSON.stringify(flow.links))}' data-reuse-label="${esc(t.reuses)}">
      <svg class="journey-links" aria-hidden="true"></svg>
      <ol class="nodes">${flow.steps.map((step) => node(step, t)).join('')}</ol>
    </div>
  </section>`;

  const details = `<aside class="card details-card" aria-labelledby="details-${index}">
    <div class="card-head"><h2 id="details-${index}">${esc(t.details)}</h2>${icon('menu', 'muted-icon')}</div>
    <dl class="details">
      <dt>${esc(t.rows.id)}</dt><dd><span class="tag">${esc(shortRunId(model.runId))}</span></dd>
      <dt>${esc(t.rows.status)}</dt><dd>${statusPill(flow.status, t)}</dd>
      <dt>${esc(t.rows.duration)}</dt><dd class="with-icon">${icon('clock-small')}${esc(formatDuration(flow.durationMs))}</dd>
      <dt>${esc(t.rows.actions)}</dt><dd>${k.actions}</dd>
      <dt>${esc(t.rows.validated)}</dt><dd><div>${k.validated}</div><div class="bar thin"><span style="width:${percent}%"></span></div></dd>
      <dt>${esc(t.rows.notInterpreted)}</dt><dd>${k.intentAvailable ? `<div>${k.notInterpreted}</div><div class="bar thin warn"><span style="width:${unknownPercent}%"></span></div>` : '<span class="muted">—</span>'}</dd>
      <dt>${esc(t.rows.target)}</dt><dd><span class="tag blue">${esc(host(model.baseUrl))}</span></dd>
      <dt>${esc(t.rows.application)}</dt><dd><span class="tag purple">${esc(model.mission)} / ${esc(flow.name)}</span></dd>
      <dt>${esc(t.rows.mode)}</dt><dd>${esc(capitalize(model.mode))}</dd>
      ${flow.confidence !== undefined ? `<dt>${esc(t.rows.confidence)}</dt><dd>${Math.round(flow.confidence * 100)}%</dd>` : ''}
      ${flow.businessProof ? `<dt>${esc(t.rows.proof)}</dt><dd><span class="tag ${flow.businessProof.status === 'PROVEN' ? 'ok' : 'warn'}">${esc(flow.businessProof.status)}</span></dd>` : ''}
      ${flow.drift ? `<dt>${esc(t.rows.drift)}</dt><dd><span class="tag warn">${esc(flow.drift)}</span></dd>` : ''}
      <dt>${esc(t.rows.date)}</dt><dd data-datetime="${esc(flow.startedAt)}">${esc(flow.startedAt.slice(0, 16).replace('T', ' '))}</dd>
    </dl>
    ${fullReport ? `<a class="primary-button" href="${esc(fullReport)}">${esc(t.fullReportButton)} →</a>` : ''}
  </aside>`;

  return `<div class="flow-view" data-flow="${index}"${index > 0 ? ' hidden' : ''}>
  ${kpis}
  <div class="row-2">${journey}${details}</div>
  <div class="row-2 bottom">${timeline(flow, index, t, shot)}${lineage(flow, index, t)}</div>
</div>`;
}

function explorationView(model: OverviewModel, t: OverviewTexts): string {
  const e = model.exploration;
  const percent = e.actionsExecuted > 0 ? Math.round((e.actionsSucceeded / e.actionsExecuted) * 100) : 0;
  return `<div class="flow-view" data-flow="0">
  <div class="kpis">
    ${kpi('ok', icon('check-bold'), String(e.actionsSucceeded), t.kpi.validated, `${t.kpi.of} ${e.actionsExecuted}`, `<div class="meter"><div class="bar"><span style="width:${percent}%"></span></div><b>${percent}%</b></div>`)}
    ${kpi('purple', icon('graph'), String(e.states), t.kpi.states, '')}
    ${kpi('warn', icon('alert'), String(e.actionsFailed + e.actionsBlocked), t.kpi.failedActions, '')}
    ${kpi('blue', icon('clock'), formatDuration(model.durationMs), t.kpi.duration, '')}
  </div>
  <section class="card empty-card" id="journey"><h2>${esc(t.noFlow)}</h2><p class="muted">${esc(t.noFlowHint)}</p></section>
</div>`;
}

function kpi(tone: string, iconSvg: string, value: string, label: string, hint: string, extra = ''): string {
  return `<div class="card kpi">
    <span class="kpi-icon ${tone}">${iconSvg}</span>
    <div class="kpi-body"><div class="kpi-value">${esc(value)}</div><div class="kpi-label">${esc(label)}</div>${hint ? `<div class="kpi-hint">${esc(hint)}</div>` : ''}${extra}</div>
  </div>`;
}

function node(step: OverviewStep, t: OverviewTexts): string {
  const generating = step.generates.length > 0;
  const classes = ['node', `tone-${step.tone}`, generating ? 'generating' : '', step.current ? 'current' : '']
    .filter(Boolean)
    .join(' ');
  const pill = generating
    ? `<span class="pill purple">${esc(t.generates)}</span>`
    : `<span class="pill ${step.tone}">${toneMark(step.tone)}${esc(t.tone[step.tone])}</span>`;
  const search = [step.title, step.subtitle, step.description, ...step.generates, ...step.reuses].join(' ');
  return `<li class="${classes}" data-step="${step.index}" data-search="${esc(search.toLowerCase())}" title="${esc(step.description)}">
    <div class="node-head"><span class="node-icon">${stepIcon(step)}</span><div class="node-text"><div class="node-num">${step.index}</div><div class="node-title">${esc(step.title)}</div><div class="node-sub">${esc(step.subtitle)}</div>${step.writes.length > 0 ? `<div class="node-req">${esc(step.writes[0] ?? '')}</div>` : ''}</div></div>
    ${pill}
  </li>`;
}

function timeline(
  flow: OverviewFlow,
  index: number,
  t: OverviewTexts,
  shot: (file: string) => string,
): string {
  const count = (filter: string): number =>
    filter === 'all'
      ? flow.steps.length
      : flow.steps.filter((step) => filterOf(step).includes(filter)).length;
  const tabs = (['all', 'valid', 'warning', 'unknown', 'failed'] as const)
    .filter((filter) => filter !== 'failed' || count('failed') > 0)
    .map(
      (filter) =>
        `<button type="button" class="tab${filter === 'all' ? ' active' : ''}" data-filter="${filter}" aria-pressed="${filter === 'all'}">${esc(t.tabs[filter])}<span class="tab-count">${count(filter)}</span></button>`,
    )
    .join('');
  const firstGenerating = flow.steps.find((step) => step.generates.length > 0)?.index;
  const rows = flow.steps
    .map((step, position) =>
      timelineRow(step, flow, t, shot, step.index === firstGenerating, position >= TIMELINE_VISIBLE),
    )
    .join('');
  const hidden = Math.max(0, flow.steps.length - TIMELINE_VISIBLE);
  return `<section class="card timeline-card" id="timeline" aria-labelledby="timeline-${index}">
    <div class="card-head">
      <h2 id="timeline-${index}">${icon('history')}${esc(t.timeline)}</h2>
      <div class="tabs" role="group" aria-label="${esc(t.timeline)}">${tabs}</div>
    </div>
    <div class="rows">${rows}</div>
    <p class="no-row muted" hidden>${esc(t.noRow)}</p>
    ${
      hidden > 0
        ? `<div class="timeline-foot"><span class="muted"><span class="dots">•••</span> ${esc(t.more(hidden))}</span><button type="button" class="link-button more-toggle" data-more="${esc(t.seeAll)} →" data-less="${esc(t.seeLess)}">${esc(t.seeAll)} →</button></div>`
        : ''
    }
  </section>`;
}

function filterOf(step: OverviewStep): string[] {
  const filters: string[] = [];
  if (step.status === 'PASSED') filters.push('valid');
  if (step.tone === 'warning') filters.push('warning');
  if (step.tone === 'failed') filters.push('failed', 'warning');
  if (step.intent.status === 'UNKNOWN' || step.intent.status === 'AMBIGUOUS') filters.push('unknown');
  return filters;
}

function timelineRow(
  step: OverviewStep,
  flow: OverviewFlow,
  t: OverviewTexts,
  shot: (file: string) => string,
  open: boolean,
  folded: boolean,
): string {
  const generating = step.generates.length > 0;
  const badge = generating
    ? `<span class="pill purple">${esc(t.generates)}</span>`
    : `<span class="pill ${step.tone}">${esc(t.tone[step.tone])}</span>`;
  const sub =
    step.kind === 'fill' && (step.generates[0] ?? step.reuses[0])
      ? `${esc(step.subtitle)} <span class="arrow-inline">→</span> <span class="key">${esc(step.generates[0] ?? step.reuses[0] ?? '')}</span>`
      : esc(step.subtitle);

  const blocks: string[] = [];
  for (const key of step.generates) {
    const entry = flow.data.find((candidate) => candidate.key === key);
    if (!entry) continue;
    blocks.push(`<div class="sub-card">
      <div class="sub-title">${icon('database-small')}${esc(t.generatedValue)} <span class="muted">· ${esc(key)}</span></div>
      ${valueBox(entry, t)}
    </div>
    <div class="sub-card">
      <div class="sub-title">${icon('flask')}${esc(t.usedIn)}</div>
      <ul class="used">${entry.uses
        .filter((use) => use.role !== 'SOURCE')
        .map(
          (use) =>
            `<li>${icon('arrow-circle')}<b>${esc(t.step)} ${pad(use.step)}</b><span>${esc(flow.steps.find((candidate) => candidate.index === use.step)?.subtitle ?? use.description)}</span></li>`,
        )
        .join('')}</ul>
    </div>`);
  }
  const facts: string[] = [`<dt>${esc(t.description)}</dt><dd><code>${esc(step.description)}</code></dd>`];
  if (step.interpretation)
    facts.push(`<dt>${esc(t.interpretation)}</dt><dd>${esc(step.interpretation)}</dd>`);
  if (step.intent.status !== 'NONE')
    facts.push(
      `<dt>${esc(t.intent)}</dt><dd>${esc(step.intent.name ?? '')} <span class="tag ${step.intent.status === 'CONFIRMED' || step.intent.status === 'PROBABLE' ? 'ok' : 'purple'}">${esc(step.intent.status)}</span>${step.intent.confidence !== undefined ? ` <span class="muted">${Math.round(step.intent.confidence * 100)}%</span>` : ''}</dd>`,
    );
  if (step.requests > 0)
    facts.push(
      `<dt>${esc(t.requests)}</dt><dd>${step.requests}${step.writes.length > 0 ? ` · <code>${step.writes.map(esc).join(' · ')}</code>` : ''}</dd>`,
    );
  if (step.notes.length > 0)
    facts.push(`<dt>${esc(t.reason)}</dt><dd>${step.notes.map(esc).join(' · ')}</dd>`);
  if (step.healed)
    facts.push(
      `<dt>${esc(t.healed)}</dt><dd><code>${esc(step.healed.from)}</code> → <code>${esc(step.healed.to)}</code></dd>`,
    );
  if (step.screenshot)
    facts.push(
      `<dt>${esc(t.screenshot)}</dt><dd><a href="${esc(shot(step.screenshot))}">${esc(t.view)}</a></dd>`,
    );

  const search = [step.title, step.subtitle, step.description, ...step.generates, ...step.reuses].join(' ');
  return `<details class="row tone-${step.tone}${generating ? ' generating' : ''}${folded ? ' folded' : ''}" data-step="${step.index}" data-filters="${filterOf(step).join(' ')}" data-search="${esc(search.toLowerCase())}"${open ? ' open' : ''}${folded ? ' hidden' : ''}>
    <summary>
      <span class="row-icon ${generating ? 'purple' : step.tone}">${generating ? icon('sparkle-small') : toneIcon(step.tone)}</span>
      <span class="row-num">${pad(step.index)}</span>
      <span class="row-text"><span class="row-title">${esc(step.title)}</span><span class="row-sub">${sub}</span></span>
      ${badge}
      <span class="row-time" data-time="${esc(step.startedAt)}">${esc(step.startedAt.slice(11, 19))}</span>
      ${icon('chevron', 'row-chevron')}
    </summary>
    <div class="row-body">
      ${blocks.length > 0 ? `<div class="sub-grid">${blocks.join('')}</div>` : ''}
      <dl class="facts">${facts.join('')}</dl>
    </div>
  </details>`;
}

function lineage(flow: OverviewFlow, index: number, t: OverviewTexts): string {
  const entries = [...flow.data].sort(
    (a, b) =>
      Number(b.uses.length > 1) - Number(a.uses.length > 1) || (a.producedAt ?? 99) - (b.producedAt ?? 99),
  );
  const head = `<div class="card-head">
      <h2 id="lineage-${index}">${icon('database')}${esc(t.lineage)}</h2>
      ${entries.length > 1 ? `<button type="button" class="ghost-button small" data-all-data>${esc(t.seeAllData)} →</button>` : ''}
    </div>`;
  if (entries.length === 0)
    return `<section class="card lineage-card" id="lineage" aria-labelledby="lineage-${index}">${head}<p class="muted">${esc(t.noData)}</p></section>`;
  const chips =
    entries.length > 1
      ? `<div class="chips" role="group" aria-label="${esc(t.testData)}">${entries
          .map(
            (entry, position) =>
              `<button type="button" class="chip${position === 0 ? ' active' : ''}" data-entry="${position}" aria-pressed="${position === 0}">${esc(entry.key)}</button>`,
          )
          .join('')}</div>`
      : '';
  return `<section class="card lineage-card" id="lineage" aria-labelledby="lineage-${index}">
    ${head}
    ${chips}
    ${entries.map((entry, position) => dataEntry(entry, position, flow, t)).join('')}
  </section>`;
}

function dataEntry(entry: OverviewDataEntry, position: number, flow: OverviewFlow, t: OverviewTexts): string {
  const generated = entry.value !== undefined || entry.strategy.startsWith('GENERATE');
  const subtitle = (step: number): string =>
    flow.steps.find((candidate) => candidate.index === step)?.subtitle ?? '';
  const producer = entry.uses.find((use) => use.role === 'SOURCE');
  const consumers = entry.uses.filter((use) => use.role !== 'SOURCE');
  return `<div class="data-entry" data-entry-panel="${position}"${position > 0 ? ' hidden' : ''}>
    <div class="data-box">
      <div class="data-head">
        <span class="data-icon">${icon('cube')}</span>
        <div class="data-main">
          <div class="data-title"><strong>${esc(entry.key)}</strong><span class="pill ${generated ? 'purple' : 'neutral'}">${esc(generated ? t.generated : entry.strategy)}</span></div>
          ${valueBox(entry, t)}
        </div>
      </div>
      <div class="data-uses-title">${esc(t.usedInSteps(entry.uses.length))}</div>
      <ul class="data-uses">${entry.uses
        .map(
          (use) =>
            `<li>${icon('check-circle')}<b>${esc(t.step)} ${pad(use.step)}</b><span>${esc(flow.steps.find((candidate) => candidate.index === use.step)?.title ?? '')} – ${esc(subtitle(use.step))}</span><span class="pill ${use.role === 'SOURCE' ? 'valid' : use.role === 'REUSE' ? 'blue' : 'neutral'}">${esc(t.roles[use.role])}</span></li>`,
        )
        .join('')}</ul>
    </div>
    <div class="data-flow-title">${esc(t.dataFlow)}</div>
    <div class="data-flow">
      <div class="df-node ok">${icon('check-circle')}<span>${esc(t.generation)}<br>${producer ? `${esc(t.step)} ${pad(producer.step)}` : '—'}</span></div>
      <span class="df-arrow" aria-hidden="true"></span>
      <div class="df-node purple"><span>${esc(entry.key)}</span></div>
      <span class="df-arrow" aria-hidden="true"></span>
      <div class="df-targets">${
        consumers.length > 0
          ? consumers
              .map(
                (use) =>
                  `<div class="df-node ${use.role === 'REUSE' ? 'blue' : 'ok'}">${icon('check-circle')}<span>${esc(t.step)} ${pad(use.step)}<br><small>${esc(flow.steps.find((candidate) => candidate.index === use.step)?.title ?? '')}</small></span></div>`,
              )
              .join('')
          : '<div class="df-node neutral"><span>—</span></div>'
      }</div>
    </div>
  </div>`;
}

function valueBox(entry: OverviewDataEntry, t: OverviewTexts): string {
  if (entry.value === undefined) return `<div class="value hidden-value">${esc(t.hiddenValue)}</div>`;
  return `<div class="value"><code>${esc(entry.value)}</code><button type="button" class="copy" data-copy="${esc(entry.value)}" aria-label="${esc(t.copy)}" data-copied="${esc(t.copied)}">${icon('copy')}</button></div>`;
}

function runStatusPill(model: OverviewModel, t: OverviewTexts): string {
  if (model.flows.length === 0) return `<span class="pill valid">${esc(t.status.PASSED)}</span>`;
  const worst = model.flows.find((flow) => flow.status === 'FAILED' || flow.status === 'BLOCKED');
  return statusPill(worst?.status ?? 'PASSED', t);
}

function statusPill(status: FlowStatus, t: OverviewTexts): string {
  const tone =
    status === 'PASSED' ? 'valid' : status === 'FAILED' || status === 'BLOCKED' ? 'failed' : 'neutral';
  return `<span class="pill ${tone}"><i class="dot"></i>${esc(t.status[status])}</span>`;
}

function toneMark(tone: OverviewTone): string {
  if (tone === 'valid') return icon('check-tiny');
  if (tone === 'warning' || tone === 'failed') return icon('alert-tiny');
  return '';
}

function toneIcon(tone: OverviewTone): string {
  if (tone === 'failed') return icon('x-small');
  if (tone === 'warning') return icon('alert-small');
  if (tone === 'unknown') return icon('question-small');
  if (tone === 'skipped' || tone === 'manual') return icon('minus-small');
  return icon('check-small');
}

function stepIcon(step: OverviewStep): string {
  if (step.generates.length > 0) return icon('sparkle');
  switch (step.title) {
    case 'Search':
      return icon('search-big');
    case 'Open':
      return icon('eye');
    case 'Create':
      return icon('plus');
  }
  switch (step.kind) {
    case 'goto':
      return icon('globe');
    case 'click':
    case 'check':
    case 'uncheck':
      return icon('cursor');
    case 'fill':
      return icon('pencil');
    case 'select':
      return icon('list');
    case 'expect':
      return icon('check-bold');
    case 'screenshot':
      return icon('camera');
    default:
      return step.writes.length > 0 ? icon('code') : icon('target');
  }
}

function sparkline(values: number[]): string {
  if (values.length < 2) return '';
  const max = Math.max(...values, 1);
  const width = 160;
  const height = 36;
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - 4 - (value / max) * (height - 8);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${points}" fill="none" stroke="var(--blue)" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function shortRunId(runId: string | undefined): string {
  if (!runId) return '#—';
  return `#${runId.length > 10 ? runId.slice(0, 8) : runId}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function initials(value: string): string {
  const words = value.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return ((words[0]?.[0] ?? 'Q') + (words[1]?.[0] ?? words[0]?.[1] ?? 'A')).toUpperCase();
}

function logo(size = 36): string {
  return `<svg class="logo" width="${size}" height="${size}" viewBox="0 0 36 36" aria-hidden="true"><defs><linearGradient id="qa-logo-${size}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3B82F6"/><stop offset="1" stop-color="#8B5CF6"/></linearGradient></defs><circle cx="17" cy="17" r="11" fill="none" stroke="url(#qa-logo-${size})" stroke-width="6"/><path d="M24 24l7 7" stroke="#8B5CF6" stroke-width="6" stroke-linecap="round"/></svg>`;
}

const ICONS: Record<string, string> = {
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  'search-big': '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  flows:
    '<circle cx="5" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 6h6a4 4 0 0 1 0 8h-2a4 4 0 0 0 0 8"/>',
  list: '<path d="M4 4v16h16"/><path d="M8 14h4M8 10h8M8 6h3"/>',
  report: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',
  chart: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 16v-4M12 16V8M16 16v-6"/>',
  database:
    '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
  'database-small':
    '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
  graph:
    '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8 7.5l3 8M16 7.5l-3 8M8.5 6h7"/>',
  file: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
  'check-bold': '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  'clock-small': '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  history: '<path d="M4 12a8 8 0 1 0 2.3-5.6L4 8.5"/><path d="M4 4v4.5h4.5M12 8v4l3 2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  sparkle: '<path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2zM19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  'sparkle-small': '<path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z"/>',
  cursor: '<path d="M5 3l14 8-6 2-3 6z"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  plus: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  code: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13 6l-2 12"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  'check-small': '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  'check-tiny': '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  'alert-small': '<path d="M12 7v6M12 17v.5"/>',
  'alert-tiny': '<path d="M12 7v6M12 17v.5"/>',
  'x-small': '<path d="M7 7l10 10M17 7L7 17"/>',
  'question-small': '<path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7v.5M12 17v.5"/>',
  'minus-small': '<path d="M7 12h10"/>',
  'arrow-circle': '<circle cx="12" cy="12" r="9"/><path d="M10 8l4 4-4 4"/>',
  'check-circle': '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
  flask: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6A2 2 0 0 0 19 18l-5-9V3"/>',
  cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V5a1 1 0 0 1 1-1h11"/>',
};

function icon(name: string, className = ''): string {
  return `<svg class="icon icon-${name}${className ? ` ${className}` : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
}

const CSS = `
:root{color-scheme:light;
--bg:#F5F6FA;--chrome:#FFFFFF;--surface:#FFFFFF;--surface-2:#F8FAFC;--border:#E4E7EF;--border-strong:#D6DAE4;--text:#111827;--text-2:#374151;--muted:#5B6478;
--accent:#4F46E5;--accent-2:#7C3AED;--accent-ink:#4338CA;--nav-hover:#F1F2F8;--shadow:0 1px 2px rgba(16,24,40,.05);
--ok:#16A34A;--ok-bg:#F0FDF4;--ok-border:#BBF7D0;--ok-soft:#DCFCE7;--ok-ink:#15803D;
--warn:#F59E0B;--warn-bg:#FFFBEB;--warn-border:#F59E0B;--warn-soft:#FEF3C7;--warn-ink:#92400E;
--purple:#8B5CF6;--purple-bg:#F5F3FF;--purple-border:#C4B5FD;--purple-soft:#EDE9FE;--purple-ink:#5B21B6;
--blue:#3B82F6;--blue-bg:#EFF6FF;--blue-border:#93C5FD;--blue-soft:#DBEAFE;--blue-ink:#1D4ED8;
--red:#DC2626;--red-bg:#FEF2F2;--red-border:#FECACA;--red-soft:#FEE2E2;--red-ink:#B91C1C;
--grey-soft:#F1F2F8;--grey-ink:#4B5563;--link:#94A3B8}
:root[data-theme="dark"]{color-scheme:dark;
--bg:#080B14;--chrome:#0A0E19;--surface:#111726;--surface-2:#0D1220;--border:#1F2638;--border-strong:#2A3248;--text:#E6E9F2;--text-2:#C9CFDD;--muted:#9AA3B8;
--accent:#5B4BD8;--accent-2:#8B5CF6;--accent-ink:#A5B4FC;--nav-hover:#161C2D;--shadow:none;
--ok:#22C55E;--ok-bg:#0F1A1B;--ok-border:#1E4B33;--ok-soft:#0E3B22;--ok-ink:#4ADE80;
--warn:#F59E0B;--warn-bg:#1E1610;--warn-border:#B45309;--warn-soft:#451A03;--warn-ink:#FCD34D;
--purple:#8B5CF6;--purple-bg:#17163A;--purple-border:#6D5BD0;--purple-soft:#2E1F6B;--purple-ink:#DDD6FE;
--blue:#3B82F6;--blue-bg:#0F1B3A;--blue-border:#1D4ED8;--blue-soft:#1E3A8A;--blue-ink:#BFDBFE;
--red:#EF4444;--red-bg:#2A1215;--red-border:#7F1D1D;--red-soft:#450A0A;--red-ink:#FCA5A5;
--grey-soft:#1A2133;--grey-ink:#A9B1C4;--link:#64748B}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent-ink);text-decoration:none}a:hover{text-decoration:underline}
button,input,select{font:inherit;color:inherit}
button{cursor:pointer}
code,.value code,kbd{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.muted{color:var(--muted)}.small{font-size:12px}
[hidden]{display:none!important}
.icon{width:18px;height:18px;flex:none}
.only-dark{display:none}:root[data-theme="dark"] .only-dark{display:block}:root[data-theme="dark"] .only-light{display:none}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
/* top bar */
.topbar{display:flex;flex-wrap:wrap;align-items:center;gap:14px 24px;padding:12px 24px;background:var(--chrome);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:5}
.brand{display:flex;align-items:center;gap:12px;min-width:210px}
.brand-name{font-weight:800;font-size:20px;letter-spacing:.02em}
.brand-tag{font-size:12px;color:var(--muted)}
.search{flex:1 1 260px;max-width:440px;margin:0 auto;display:flex;align-items:center;gap:10px;height:40px;padding:0 12px;border:1px solid var(--border);border-radius:10px;background:var(--surface-2);color:var(--muted)}
.search input{flex:1;min-width:0;border:0;background:transparent;outline:none;color:var(--text);font-size:13px}
.search:focus-within{border-color:var(--accent)}
kbd{font-size:11px;color:var(--muted);border:1px solid var(--border);border-radius:6px;padding:1px 6px;background:var(--surface)}
.top-actions{display:flex;align-items:center;gap:14px}
.mode-chip{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border:1px solid var(--ok-border);border-radius:999px;background:var(--ok-bg);color:var(--ok-ink);font-size:13px;font-weight:600}
.mode-chip .dot{width:7px;height:7px;border-radius:50%;background:var(--ok)}
.icon-button{position:relative;width:44px;height:44px;display:grid;place-items:center;border:0;border-radius:10px;background:transparent;color:var(--text-2)}
.icon-button:hover{background:var(--nav-hover);text-decoration:none}
.icon-button .icon{width:22px;height:22px}
.badge-count{position:absolute;top:5px;right:4px;min-width:17px;height:17px;padding:0 4px;border-radius:9px;background:var(--red);color:#fff;font-size:10px;font-weight:700;display:grid;place-items:center}
.mission{display:flex;align-items:center;gap:10px}
.avatar{width:38px;height:38px;border-radius:50%;background:#3B5BDB;color:#fff;display:grid;place-items:center;font-weight:700;font-size:14px;flex:none}
.mission-name{display:block;font-weight:600;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mission-host{display:block;font-size:12px;color:var(--muted)}
/* shell */
.shell{display:flex;flex-wrap:wrap;align-items:stretch;min-height:calc(100vh - 69px)}
.sidebar{flex:1 1 236px;max-width:100%;display:flex;flex-direction:column;gap:3px;padding:20px 14px;background:var(--chrome);border-right:1px solid var(--border)}
.nav-item{display:flex;align-items:center;gap:12px;min-height:42px;padding:9px 14px;border-radius:10px;color:var(--text-2)}
.nav-item:hover{background:var(--nav-hover);text-decoration:none}
.nav-item.active{background:linear-gradient(90deg,var(--accent),var(--accent-2));color:#fff;font-weight:600}
.nav-item span:first-of-type{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.nav-count{flex:none!important;background:var(--ok-soft);color:var(--ok-ink);font-size:11px;font-weight:700;padding:1px 8px;border-radius:999px}
.nav-group{font-size:11px;letter-spacing:.08em;color:var(--muted);font-weight:600;margin:16px 8px 6px}
.side-foot{margin-top:auto;padding-top:32px}
.side-card{border:1px solid var(--border);border-radius:14px;background:var(--surface-2);padding:16px;display:flex;flex-direction:column;gap:10px}
.side-card-head{display:flex;gap:10px;align-items:flex-start}
.side-card p{margin:0}
.wave{width:100%;height:44px}
.stack{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:7px;font-size:12px;color:var(--text-2)}
.stack li::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--purple-border);margin-right:8px;vertical-align:middle}
/* main */
.main{flex:999 1 560px;min-width:0;max-width:1320px;padding:24px;display:flex;flex-direction:column;gap:20px}
.page-head{display:flex;flex-wrap:wrap;gap:12px 20px;justify-content:space-between;align-items:flex-start}
h1{margin:0;font-size:26px;font-weight:800}
.lead{margin:4px 0 0;color:var(--muted)}
.page-tools{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.select{position:relative;display:inline-flex;align-items:center;height:40px;border:1px solid var(--border);border-radius:10px;background:var(--surface);padding:0 12px;gap:8px}
.select select{appearance:none;border:0;background:transparent;padding-right:22px;height:38px;cursor:pointer;max-width:260px}
.select .icon{position:absolute;right:10px;pointer-events:none;width:14px;height:14px;color:var(--muted)}
.run-chip{display:flex;align-items:center;gap:10px;height:40px;padding:0 12px;border:1px solid var(--border);border-radius:10px;background:var(--surface);font-size:13px}
.run-chip strong{font-size:15px}
.flow-view{display:flex;flex-direction:column;gap:20px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px;box-shadow:var(--shadow);min-width:0}
.card-head{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center;justify-content:space-between;margin-bottom:14px}
.card-head h2{margin:0;font-size:16px;font-weight:700;display:flex;align-items:center;gap:8px}
.card-head h2 .icon{color:var(--text-2)}
.muted-icon{color:var(--muted)}
.ghost-button{display:inline-flex;align-items:center;min-height:34px;padding:6px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface);font-size:13px;color:var(--text-2)}
.ghost-button:hover{background:var(--nav-hover);text-decoration:none}
.ghost-button.small{font-size:12px;min-height:30px;padding:4px 10px}
.primary-button{display:block;text-align:center;margin-top:auto;padding:12px;border-radius:10px;background:linear-gradient(90deg,var(--blue),var(--accent-2));color:#fff;font-weight:700}
.primary-button:hover{text-decoration:none;filter:brightness(1.05)}
.link-button{border:0;background:transparent;color:var(--accent-ink);padding:6px 0;min-height:32px}
/* kpis */
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:16px}
.kpi{display:flex;gap:14px;align-items:flex-start}
.kpi-icon{flex:none;width:48px;height:48px;border-radius:50%;display:grid;place-items:center}
.kpi-icon .icon{width:24px;height:24px}
.kpi-icon.ok{background:var(--ok);color:#fff}.kpi-icon.ok .icon{stroke-width:3}
.kpi-icon.purple{background:var(--purple-soft);color:var(--purple-ink)}
.kpi-icon.warn{background:var(--warn);color:#1A1205}.kpi-icon.warn .icon{stroke-width:2}
.kpi-icon.blue{background:var(--blue-soft);color:var(--blue-ink)}
.kpi-body{flex:1;min-width:0}
.kpi-value{font-size:28px;font-weight:800;line-height:1.15}
.kpi-label{color:var(--text-2)}
.kpi-hint{font-size:12px;color:var(--muted)}
.meter{display:flex;align-items:center;gap:10px;margin-top:10px;font-size:12px}
.bar{flex:1;height:6px;border-radius:3px;background:var(--grey-soft);overflow:hidden}
.bar span{display:block;height:100%;border-radius:3px;background:var(--ok)}
.bar.thin{height:4px;margin-top:3px}.bar.warn span{background:var(--warn)}
.spark{width:100%;height:30px;margin-top:4px;display:block}
/* layout rows */
.row-2{display:flex;flex-wrap:wrap;gap:16px;align-items:stretch}
.journey-card{flex:3 1 560px}
.details-card{flex:1 1 260px;display:flex;flex-direction:column}
.timeline-card{flex:3 1 520px}
.lineage-card{flex:2 1 340px}
.empty-card h2{margin:0 0 6px;font-size:18px}
/* legend */
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--text-2)}
.legend span{display:inline-flex;align-items:center;gap:6px}
.lg{width:8px;height:8px;border-radius:50%;display:inline-block}
.lg.valid{background:var(--ok)}.lg.warning{background:var(--warn)}.lg.failed{background:var(--red)}.lg.unknown{background:var(--purple)}
.lg.current{background:var(--blue);box-shadow:0 0 0 2px var(--blue-soft)}
.flow-desc{margin:-6px 0 12px}
/* journey */
.journey{position:relative;padding:6px 2px 10px}
.journey-links{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}
.journey-links path{fill:none;stroke:var(--purple);stroke-width:1.5;stroke-dasharray:4 4}
.journey-links .head{fill:var(--purple);stroke:none}
.reuse-label{position:absolute;transform:translate(-50%,-50%);white-space:nowrap;font-size:12px;font-weight:600;color:var(--purple-ink);background:var(--purple-soft);border:1px solid var(--purple-border);padding:3px 12px;border-radius:999px;pointer-events:none;z-index:1}
.nodes{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(158px,1fr));column-gap:38px;row-gap:64px;position:relative}
.node{position:relative;display:flex;flex-direction:column;justify-content:space-between;gap:10px;padding:14px;border-radius:12px;border:1px solid var(--border);background:var(--surface-2);min-height:112px;transition:opacity .15s}
.node::after{content:"";position:absolute;top:50%;right:-29px;width:20px;height:1.5px;background:var(--link)}
.node::before{content:"";position:absolute;top:50%;right:-36px;width:0;height:0;transform:translateY(-50%);border-left:7px solid var(--link);border-top:5px solid transparent;border-bottom:5px solid transparent}
.node.row-end::after,.node.row-end::before,.node:last-child::after,.node:last-child::before{display:none}
.node-head{display:flex;gap:10px;align-items:flex-start}
.node-icon{flex:none;width:36px;height:36px;border-radius:50%;display:grid;place-items:center;background:var(--grey-soft);color:var(--grey-ink)}
.node-text{min-width:0}
.node-num{font-size:12px;color:var(--muted)}
.node-title{font-weight:700}
.node-sub{font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}
.node-req{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text-2);margin-top:2px;overflow-wrap:anywhere}
.node .pill{align-self:center}
.node.tone-valid{border-color:var(--ok-border);background:var(--ok-bg)}.node.tone-valid .node-icon{background:var(--ok-soft);color:var(--ok-ink)}
.node.tone-warning{border-color:var(--warn-border);background:var(--warn-bg)}.node.tone-warning .node-icon{background:var(--warn-soft);color:var(--warn-ink)}
.node.tone-failed{border-color:var(--red-border);background:var(--red-bg)}.node.tone-failed .node-icon{background:var(--red-soft);color:var(--red-ink)}
.node.tone-unknown{border-color:var(--purple-border);background:var(--purple-bg)}.node.tone-unknown .node-icon{background:var(--purple-soft);color:var(--purple-ink)}
.node.generating{border:1.5px solid var(--purple);background:var(--purple-bg);box-shadow:0 0 0 3px color-mix(in srgb,var(--purple) 16%,transparent)}
.node.generating .node-icon{background:var(--purple-soft);color:var(--purple-ink)}
.node.current{box-shadow:0 0 0 2px var(--blue),0 0 0 6px var(--blue-soft)}
.node.dim{opacity:.35}
/* pills & tags */
.pill{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:700;padding:3px 10px;border-radius:6px;white-space:nowrap;background:var(--grey-soft);color:var(--grey-ink)}
.pill .icon{width:12px;height:12px;stroke-width:3}
.pill .dot{width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block}
.pill.valid{background:var(--ok-soft);color:var(--ok-ink)}
.pill.warning{background:var(--warn-soft);color:var(--warn-ink)}
.pill.failed{background:var(--red-soft);color:var(--red-ink)}
.pill.unknown,.pill.purple{background:var(--purple-soft);color:var(--purple-ink)}
.pill.blue{background:var(--blue-soft);color:var(--blue-ink)}
.tag{display:inline-block;padding:2px 8px;border-radius:6px;background:var(--grey-soft);font-size:12px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}
.tag.ok{background:var(--ok-soft);color:var(--ok-ink)}.tag.warn{background:var(--warn-soft);color:var(--warn-ink)}
.tag.blue{background:var(--blue-soft);color:var(--blue-ink)}.tag.purple{background:var(--purple-soft);color:var(--purple-ink)}
/* details */
.details{margin:0 0 18px;display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px 14px;align-items:center;font-size:13px}
.details dt{color:var(--muted)}.details dd{margin:0;min-width:0}
.with-icon{display:flex;align-items:center;gap:6px}.with-icon .icon{width:15px;height:15px;color:var(--muted)}
/* timeline */
.tabs{display:flex;flex-wrap:wrap;gap:6px}
.tab{min-height:32px;padding:0 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);font-size:12px;font-weight:600;color:var(--text-2);display:inline-flex;align-items:center;gap:6px}
.tab.active{border-color:var(--accent);background:var(--purple-soft);color:var(--purple-ink)}
:root:not([data-theme="dark"]) .tab.active{background:#EEF2FF;color:#3730A3}
.tab-count{font-weight:500;opacity:.75}
.rows{display:flex;flex-direction:column}
.row{border-bottom:1px solid var(--border)}
.row[open].generating{border:1.5px solid var(--purple);background:var(--purple-bg);border-radius:12px;margin:6px 0}
.row summary{list-style:none;display:flex;align-items:center;gap:14px;padding:12px 10px;min-height:52px;cursor:pointer}
.row summary::-webkit-details-marker{display:none}
.row summary:hover .row-title{text-decoration:underline}
.row-icon{flex:none;width:28px;height:28px;border-radius:8px;display:grid;place-items:center;color:#fff;background:var(--ok)}
.row-icon .icon{width:16px;height:16px;stroke-width:3}
.row-icon.purple{background:var(--purple)}.row-icon.purple .icon{stroke-width:2}
.row-icon.warning{background:var(--warn);color:#1A1205}.row-icon.failed{background:var(--red)}
.row-icon.unknown{background:var(--purple)}.row-icon.skipped,.row-icon.manual{background:var(--grey-soft);color:var(--grey-ink)}
.row-num{width:22px;color:var(--text-2);font-weight:600}
.row-text{flex:1;min-width:0}
.row-title{display:block;font-weight:700}
.row-sub{display:block;font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row-sub .key{color:var(--text-2)}.arrow-inline{color:var(--purple)}
.row-time{font-size:12px;color:var(--muted);width:64px;text-align:right;font-variant-numeric:tabular-nums}
.row-chevron{width:16px;height:16px;color:var(--muted);transition:transform .15s}
.row[open] .row-chevron{transform:rotate(180deg)}
.row-body{padding:2px 14px 14px 52px;display:flex;flex-direction:column;gap:12px;border-left:1.5px dashed transparent}
.row[open].generating .row-body{border-left-color:var(--purple-border);margin-left:24px;padding-left:26px}
.sub-grid{display:flex;flex-wrap:wrap;gap:12px}
.sub-card{flex:1 1 220px;border:1px solid var(--border);border-radius:10px;padding:12px;background:var(--surface)}
.sub-title{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;margin-bottom:8px}
.sub-title .icon{width:15px;height:15px;color:var(--text-2)}
.used{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;font-size:13px}
.used li{display:flex;align-items:center;gap:8px}
.used .icon{width:16px;height:16px;color:var(--ok)}
.used b{color:var(--accent-ink);white-space:nowrap}
.facts{margin:0;display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 12px;font-size:12px}
.facts dt{color:var(--muted)}.facts dd{margin:0;min-width:0;overflow-wrap:anywhere}
.facts code{font-size:11.5px;background:var(--surface-2);border:1px solid var(--border);border-radius:5px;padding:1px 5px}
.value{display:flex;align-items:center;justify-content:space-between;gap:8px;border:1px solid var(--border-strong);border-radius:8px;padding:6px 6px 6px 12px;background:var(--surface-2)}
.value code{font-size:15px;overflow-wrap:anywhere}
.hidden-value{font-size:12px;color:var(--muted);padding:9px 12px}
.copy{flex:none;width:34px;height:34px;display:grid;place-items:center;border:0;border-radius:8px;background:transparent;color:var(--text-2)}
.copy:hover{background:var(--nav-hover)}
.copy.done{color:var(--ok-ink)}
.timeline-foot{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px;padding:12px 10px 0;font-size:13px}
.dots{letter-spacing:2px;margin-right:6px}
.no-row{padding:16px 10px;margin:0}
/* lineage */
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.chip{min-height:30px;padding:2px 10px;border:1px solid var(--border);border-radius:999px;background:var(--surface);font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text-2)}
.chip.active{border-color:var(--purple);background:var(--purple-soft);color:var(--purple-ink)}
.data-entry{display:flex;flex-direction:column;gap:14px}
.data-box{border:1px solid var(--border);border-radius:12px;padding:14px;background:var(--surface-2);display:flex;flex-direction:column;gap:12px}
.data-head{display:flex;gap:12px;align-items:center}
.data-icon{flex:none;width:44px;height:44px;border-radius:50%;background:var(--purple-soft);color:var(--purple-ink);display:grid;place-items:center}
.data-icon .icon{width:22px;height:22px}
.data-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
.data-title{display:flex;justify-content:space-between;align-items:center;gap:8px}
.data-title strong{overflow-wrap:anywhere}
.data-main .value{background:var(--surface)}
.data-uses-title,.data-flow-title{font-size:13px;font-weight:600}
.data-uses{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.data-uses li{display:flex;align-items:center;gap:10px;border:1px solid var(--border);border-radius:8px;padding:8px 10px;font-size:13px;background:var(--surface)}
.data-uses li .icon{width:16px;height:16px;color:var(--ok)}
.data-uses li b{white-space:nowrap}
.data-uses li span:not(.pill){flex:1;min-width:0;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.data-flow{display:flex;align-items:center;gap:6px}
.df-node{display:flex;align-items:center;gap:6px;min-width:0;overflow-wrap:anywhere;border-radius:10px;padding:8px 10px;font-size:12px;font-weight:600;border:1px solid var(--border);background:var(--surface-2)}
.df-node .icon{width:16px;height:16px}
.df-node small{font-weight:500;opacity:.85}
.df-node.ok{border-color:var(--ok-border);background:var(--ok-bg);color:var(--ok-ink)}
.df-node.purple{border-color:var(--purple-border);background:var(--purple-bg);color:var(--purple-ink)}
.df-node.blue{border-color:var(--blue-border);background:var(--blue-bg);color:var(--blue-ink)}
.df-targets{display:flex;flex-direction:column;gap:8px}
.df-arrow{flex:none;width:18px;border-top:1.5px dashed var(--purple);position:relative}
.df-arrow::after{content:"";position:absolute;right:-2px;top:-5px;border-left:6px solid var(--purple);border-top:4px solid transparent;border-bottom:4px solid transparent}
@media (max-width:720px){
  .topbar{padding:12px 16px}.main{padding:16px}.mission{display:none}
  .sidebar{border-right:0;border-bottom:1px solid var(--border)}
  .side-foot{display:none}
  .row summary{gap:8px;flex-wrap:wrap}.row-time{width:auto}
  .row-body,.row[open].generating .row-body{padding-left:12px;margin-left:0}
}
@media print{.topbar{position:static}.sidebar,.search,.top-actions{display:none}.row-body{display:flex}}
`;

const SCRIPT = `
(function(){
  var root=document.documentElement;
  var toggle=document.getElementById('theme-toggle');
  function syncToggle(){if(!toggle)return;var dark=root.dataset.theme==='dark';toggle.setAttribute('aria-label',dark?toggle.dataset.light:toggle.dataset.dark);toggle.setAttribute('aria-pressed',String(dark));}
  syncToggle();
  if(toggle)toggle.addEventListener('click',function(){root.dataset.theme=root.dataset.theme==='dark'?'light':'dark';try{localStorage.setItem('qa-crawler-theme',root.dataset.theme);}catch(e){}syncToggle();});
  var pad=function(n){return String(n).padStart(2,'0');};
  document.querySelectorAll('[data-time]').forEach(function(el){var d=new Date(el.dataset.time);if(!isNaN(d))el.textContent=pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds());});
  var lang=root.lang||'en';
  document.querySelectorAll('[data-datetime]').forEach(function(el){var d=new Date(el.dataset.datetime);if(isNaN(d))return;try{el.textContent=d.toLocaleDateString(lang,{day:'numeric',month:'short',year:'numeric'})+(el.closest('.run-chip')?' · ':', ')+pad(d.getHours())+':'+pad(d.getMinutes());}catch(e){}});
  var views=[].slice.call(document.querySelectorAll('.flow-view'));
  function current(){return views.find(function(v){return !v.hidden;})||views[0];}
  function layout(view){
    if(!view)return;var journey=view.querySelector('.journey');if(!journey)return;
    var nodes=[].slice.call(journey.querySelectorAll('.node'));
    nodes.forEach(function(node,i){var next=nodes[i+1];node.classList.toggle('row-end',!next||next.offsetTop!==node.offsetTop);});
    var svg=journey.querySelector('.journey-links');
    journey.querySelectorAll('.reuse-label').forEach(function(l){l.remove();});
    while(svg.firstChild)svg.removeChild(svg.firstChild);
    var links=[];try{links=JSON.parse(journey.dataset.links||'[]');}catch(e){}
    if(!links.length)return;
    var box=journey.getBoundingClientRect();
    var rect=function(step){var n=journey.querySelector('.node[data-step="'+step+'"]');if(!n)return null;var r=n.getBoundingClientRect();return {x:r.left-box.left,y:r.top-box.top,w:r.width,h:r.height};};
    var ns='http://www.w3.org/2000/svg';var labelled={};var lanes={};
    links.forEach(function(link){
      var a=rect(link.from),b=rect(link.to);if(!a||!b)return;
      var lane=(lanes[a.y]=(lanes[a.y]||0)+1)-1;
      var ax=a.x+a.w/2+(lane%3-1)*10,bx=b.x+b.w/2,d,lx,ly,head;
      if(Math.abs(a.y-b.y)<4){var y=Math.max(a.y+a.h,b.y+b.h)+22+lane*8;d='M'+ax+' '+(a.y+a.h)+' V'+y+' H'+bx+' V'+(b.y+b.h+6);lx=(ax+bx)/2;ly=y;head=[bx,b.y+b.h,-1];}
      else{var down=b.y>a.y;var gx=b.x>24?b.x-19:Math.min(b.x+b.w+19,box.width-4);if(b.x<=24&&b.x+b.w+19>box.width-4)gx=4;var ya=down?a.y+a.h+22+lane*6:a.y-22-lane*6;var yb=down?b.y-22:b.y+b.h+22;d='M'+ax+' '+(down?a.y+a.h:a.y)+' V'+ya+' H'+gx+' V'+yb+' H'+bx+' V'+(down?b.y-6:b.y+b.h+6);lx=(ax+gx)/2;ly=ya;head=down?[bx,b.y,1]:[bx,b.y+b.h,-1];}
      var p=document.createElementNS(ns,'path');p.setAttribute('d',d);svg.appendChild(p);
      var h=document.createElementNS(ns,'path');h.setAttribute('class','head');h.setAttribute('d','M'+(head[0]-5)+' '+(head[1]-7*head[2])+' L'+(head[0]+5)+' '+(head[1]-7*head[2])+' L'+head[0]+' '+head[1]+' Z');svg.appendChild(h);
      var id=link.key+'@'+link.from;
      if(!labelled[id]){labelled[id]=true;var label=document.createElement('span');label.className='reuse-label';var keys=links.filter(function(l){return l.from===link.from;}).map(function(l){return l.key;});var distinct=keys.filter(function(k,i){return keys.indexOf(k)===i;});label.textContent=journey.dataset.reuseLabel+(distinct.length>1?' · '+link.key:'');label.style.left=Math.min(Math.max(lx,90),box.width-90)+'px';label.style.top=ly+'px';journey.appendChild(label);}
    });
  }
  var frame=0;function relayout(){cancelAnimationFrame(frame);frame=requestAnimationFrame(function(){layout(current());});}
  window.addEventListener('resize',relayout);window.addEventListener('load',relayout);relayout();
  var select=document.getElementById('flow-select');
  if(select)select.addEventListener('change',function(){views.forEach(function(v){v.hidden=v.dataset.flow!==select.value;});applySearch();relayout();});
  views.forEach(function(view){
    var rows=[].slice.call(view.querySelectorAll('.row'));var filter='all';var expanded=false;
    var more=view.querySelector('.more-toggle');
    view.refresh=function(query){var shown=0;rows.forEach(function(row){var match=(filter==='all'||(' '+row.dataset.filters+' ').indexOf(' '+filter+' ')>=0)&&(!query||row.dataset.search.indexOf(query)>=0);var fold=row.classList.contains('folded')&&!expanded&&filter==='all'&&!query;row.hidden=!match||fold;if(match)shown++;});var empty=view.querySelector('.no-row');if(empty)empty.hidden=shown>0;view.querySelectorAll('.node').forEach(function(n){n.classList.toggle('dim',!!query&&n.dataset.search.indexOf(query)<0);});};
    view.querySelectorAll('.tab').forEach(function(tab){tab.addEventListener('click',function(){filter=tab.dataset.filter;view.querySelectorAll('.tab').forEach(function(t){var on=t===tab;t.classList.toggle('active',on);t.setAttribute('aria-pressed',String(on));});view.refresh(query());});});
    if(more)more.addEventListener('click',function(){expanded=!expanded;more.textContent=expanded?more.dataset.less:more.dataset.more;view.refresh(query());});
    view.querySelectorAll('.chip[data-entry]').forEach(function(chip){chip.addEventListener('click',function(){view.querySelectorAll('.chip[data-entry]').forEach(function(c){var on=c===chip;c.classList.toggle('active',on);c.setAttribute('aria-pressed',String(on));});view.querySelectorAll('[data-entry-panel]').forEach(function(p){p.hidden=p.dataset.entryPanel!==chip.dataset.entry;});});});
    var all=view.querySelector('[data-all-data]');
    if(all)all.addEventListener('click',function(){var panels=view.querySelectorAll('[data-entry-panel]');var open=[].some.call(panels,function(p){return p.hidden;});panels.forEach(function(p,i){p.hidden=open?false:i>0;});view.querySelectorAll('.chip[data-entry]').forEach(function(c,i){c.classList.toggle('active',open||i===0);});});
  });
  var search=document.getElementById('search');
  function query(){return search?search.value.trim().toLowerCase():'';}
  function applySearch(){var v=current();if(v&&v.refresh)v.refresh(query());}
  if(search){search.addEventListener('input',applySearch);document.addEventListener('keydown',function(e){if(e.key==='/'&&document.activeElement!==search&&!/input|select|textarea/i.test(document.activeElement.tagName)){e.preventDefault();search.focus();}});}
  document.querySelectorAll('.copy').forEach(function(button){button.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();var text=button.dataset.copy;var done=function(){button.classList.add('done');button.title=button.dataset.copied;setTimeout(function(){button.classList.remove('done');},1200);};if(navigator.clipboard)navigator.clipboard.writeText(text).then(done,function(){});});});
})();
`;
