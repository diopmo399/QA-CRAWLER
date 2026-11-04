import type {
  JourneyTraceability,
  TraceCorrespondence,
  TraceEvent,
  TraceFlowNode,
  TraceVariable,
} from '../core/journey-trace.js';
import { icon } from './dashboard-parts.js';
import type { DashboardState } from './dashboard-view.js';
import { esc } from './view.js';

/**
 * LA VUE « DONNÉES & TRAÇABILITÉ » du compositeur (modèle : src/sdk/core/journey-trace.ts) :
 *   en haut, le flux d'exécution (liens de contrôle) et les liens de données, distingués ;
 *   à gauche, les données du scénario (filtrables) ; au centre, la chronologie des événements observés de la
 *   donnée choisie, ou son graphe ; à droite, sa fiche (provenance, version, type, valeur, producteurs,
 *   consommateurs, statut et justification).
 * Tout vient du serveur : définitions des contrats, correspondances, traces d'une exécution réelle. Sans
 * exécution, la vue le dit ; « Confirmée » n'apparaît qu'avec une preuve observée.
 */

export interface TraceUi {
  loading?: boolean;
  error?: string;
  data?: JourneyTraceability;
  /** La logique du parcours au moment du chargement (périmée si le parcours a changé depuis). */
  key?: string;
  run?: string;
  tab: 'trace' | 'vars' | 'map' | 'graph';
  center: 'timeline' | 'graph';
  query: string;
  selected?: string;
}

export const emptyTraceUi = (): TraceUi => ({ tab: 'trace', center: 'timeline', query: '' });

const FR = {
  view: 'Données & Traçabilité',
  tabs: {
    trace: 'Traçabilité des données',
    vars: (count: number) => `Variables (${String(count)})`,
    map: 'Correspondances',
    graph: 'Graphique de dépendances',
  },
  run: 'Exécution',
  runNone: 'Aucune exécution',
  runLabel: (date: string, verdict: string, simulation: boolean) =>
    `${date} · ${verdict}${simulation ? ' · simulation' : ''}`,
  load: 'Actualiser',
  loading: 'Chargement de la traçabilité…',
  noExecution:
    'Aucune exécution réelle de ce parcours : seules les définitions des contrats sont montrées. Lancez une exécution de simulation (onglet Simulation) ou exécutez le scénario créé.',
  noTraces:
    'Cette exécution ne contient pas de trace des données (exécution antérieure à la traçabilité) : rien n’est inventé.',
  stale: 'Le parcours a changé depuis ce chargement : actualisez.',
  flowTitle: 'Flux d’exécution',
  dataLinks: 'Liens de données',
  controlLink: 'Lien de contrôle',
  dataLink: 'Lien de données',
  output: 'Sortie',
  input: 'Entrée',
  variablesTitle: 'Données du scénario',
  search: 'Rechercher une donnée…',
  noVariable: 'Aucune donnée ne correspond.',
  traceOf: (key: string) => `Traçabilité : ${key}`,
  uses: (count: number) => `${String(count)} utilisation(s)`,
  timeline: 'Vue Timeline',
  graphView: 'Vue Graphe',
  noEvent: 'Aucun événement observé pour cette donnée dans l’exécution choisie.',
  pick: 'Choisissez une donnée à gauche.',
  origins: {
    GENERATED: 'Génération',
    CAPTURED: 'Capture',
    TRANSFORMED: 'Transformation',
    ITERATION: 'Itération',
    USED: 'Utilisation',
    OVERWRITE_REFUSED: 'Écrasement refusé',
  } as Record<string, string>,
  uses2: { ASSIGN: 'saisie', READ: 'lecture', VALIDATE: 'vérification' } as Record<string, string>,
  value: 'Valeur',
  valueUsed: 'Valeur utilisée',
  masked: 'masquée (donnée sensible)',
  withheld: 'non conservée (rétention)',
  fixed: 'valeur fixe du jeu',
  openBlock: 'Ouvrir le bloc',
  openStep: (step: number) => `Étape ${String(step)}`,
  iteration: (id: string, index: number) => `${id} · itération ${String(index)}`,
  detailTitle: 'Détail de la donnée',
  identifier: 'Identifiant',
  label: 'Libellé',
  type: 'Type',
  meaning: 'Sens métier',
  version: 'Version',
  provenance: 'Provenance',
  lastValue: 'Valeur (exécution choisie)',
  noValue: 'aucune valeur observée',
  usedWhere: (count: number) => `Où est-elle utilisée ? (${String(count)})`,
  metadata: 'Métadonnées',
  firstSeen: 'Première apparition',
  lastSeen: 'Dernière utilisation',
  useCount: 'Nombre d’utilisations',
  status: 'Statut de traçabilité',
  why: 'Justification',
  problems: 'Problèmes',
  none: '—',
  statuses: {
    CONFIRMED: 'Confirmée',
    PRODUCED_ONLY: 'Produite, non utilisée',
    STATIC: 'Valeur fixe',
    NOT_OBSERVED: 'Non observée',
    NO_EXECUTION: 'Non exécutée',
    MISSING: 'Manquante',
    UNSUPPORTED: 'Non prise en charge',
  } as Record<string, string>,
  originsDef: {
    GENERATED: 'Générée',
    CAPTURED: 'Capturée',
    DATA: 'Jeu de données',
    INPUT: 'Entrée',
    ITERATION: 'Variable d’itération',
    VALUE: 'Saisie dans le parcours',
    UNKNOWN: 'Inconnue',
  } as Record<string, string>,
  kinds: {
    EXPLICIT: 'Explicite',
    AUTOMATIC: 'Automatique (même nom)',
    DATA: 'Jeu de données',
    LOOP: 'Variable d’itération',
    SUGGESTED: 'Suggérée — non confirmée',
    MISSING: 'Manquante',
  } as Record<string, string>,
  colKey: 'Donnée',
  colType: 'Type',
  colOrigin: 'Origine',
  colVersion: 'Version',
  colProducers: 'Producteurs',
  colConsumers: 'Consommateurs',
  colStatus: 'Statut',
  colFrom: 'Source',
  colTo: 'Cible',
  colKind: 'Correspondance',
  colReason: 'Raison',
  noMap: 'Aucune correspondance.',
  graphNone: 'Aucun lien de données entre blocs.',
  graphNote:
    'Un arc relie le bloc qui produit une donnée au bloc qui la lit (d’après les correspondances du parcours).',
  notes: 'Limites',
  data: 'jeu de données',
};
type Text = typeof FR;
const EN: Text = {
  view: 'Data & Traceability',
  tabs: {
    trace: 'Data traceability',
    vars: (count) => `Variables (${String(count)})`,
    map: 'Mappings',
    graph: 'Dependency graph',
  },
  run: 'Run',
  runNone: 'No run',
  runLabel: (date, verdict, simulation) => `${date} · ${verdict}${simulation ? ' · simulation' : ''}`,
  load: 'Refresh',
  loading: 'Loading the traceability…',
  noExecution:
    'No real run of this journey: only the contract definitions are shown. Start a simulation run (Simulation tab) or run the created scenario.',
  noTraces: 'This run has no data trace (a run older than the traceability): nothing is invented.',
  stale: 'The journey changed since this load: refresh.',
  flowTitle: 'Execution flow',
  dataLinks: 'Data links',
  controlLink: 'Control link',
  dataLink: 'Data link',
  output: 'Output',
  input: 'Input',
  variablesTitle: 'Scenario data',
  search: 'Search a data item…',
  noVariable: 'No data item matches.',
  traceOf: (key) => `Traceability: ${key}`,
  uses: (count) => `${String(count)} use(s)`,
  timeline: 'Timeline view',
  graphView: 'Graph view',
  noEvent: 'No event observed for this data item in the chosen run.',
  pick: 'Choose a data item on the left.',
  origins: {
    GENERATED: 'Generation',
    CAPTURED: 'Capture',
    TRANSFORMED: 'Transformation',
    ITERATION: 'Iteration',
    USED: 'Use',
    OVERWRITE_REFUSED: 'Overwrite refused',
  },
  uses2: { ASSIGN: 'typed', READ: 'read', VALIDATE: 'checked' },
  value: 'Value',
  valueUsed: 'Value used',
  masked: 'masked (sensitive)',
  withheld: 'not kept (retention)',
  fixed: 'fixed data value',
  openBlock: 'Open the block',
  openStep: (step) => `Step ${String(step)}`,
  iteration: (id, index) => `${id} · iteration ${String(index)}`,
  detailTitle: 'Data item detail',
  identifier: 'Identifier',
  label: 'Label',
  type: 'Type',
  meaning: 'Business meaning',
  version: 'Version',
  provenance: 'Provenance',
  lastValue: 'Value (chosen run)',
  noValue: 'no value observed',
  usedWhere: (count) => `Where is it used? (${String(count)})`,
  metadata: 'Metadata',
  firstSeen: 'First seen',
  lastSeen: 'Last use',
  useCount: 'Number of uses',
  status: 'Traceability status',
  why: 'Justification',
  problems: 'Problems',
  none: '—',
  statuses: {
    CONFIRMED: 'Confirmed',
    PRODUCED_ONLY: 'Produced, not used',
    STATIC: 'Fixed value',
    NOT_OBSERVED: 'Not observed',
    NO_EXECUTION: 'Not run',
    MISSING: 'Missing',
    UNSUPPORTED: 'Not supported',
  },
  originsDef: {
    GENERATED: 'Generated',
    CAPTURED: 'Captured',
    DATA: 'Data set',
    INPUT: 'Input',
    ITERATION: 'Iteration variable',
    VALUE: 'Typed in the journey',
    UNKNOWN: 'Unknown',
  },
  kinds: {
    EXPLICIT: 'Explicit',
    AUTOMATIC: 'Automatic (same name)',
    DATA: 'Data set',
    LOOP: 'Iteration variable',
    SUGGESTED: 'Suggested — not confirmed',
    MISSING: 'Missing',
  },
  colKey: 'Data',
  colType: 'Type',
  colOrigin: 'Origin',
  colVersion: 'Version',
  colProducers: 'Producers',
  colConsumers: 'Consumers',
  colStatus: 'Status',
  colFrom: 'Source',
  colTo: 'Target',
  colKind: 'Mapping',
  colReason: 'Reason',
  noMap: 'No mapping.',
  graphNone: 'No data link between blocks.',
  graphNote:
    'An arc links the block producing a data item to the block reading it (from the journey mappings).',
  notes: 'Limits',
  data: 'data set',
};
export const traceUiText = (state: DashboardState): Text => (state.t.locale === 'en' ? EN : FR);

const time = (iso: string | undefined, locale: string): string =>
  iso
    ? new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '—';

const statusTone = (status: string): string =>
  status === 'CONFIRMED'
    ? 'ok'
    : status === 'MISSING' || status === 'UNSUPPORTED'
      ? 'ko'
      : status === 'STATIC' || status === 'PRODUCED_ONLY'
        ? 'info'
        : 'warn';

function valueChip(
  t: Text,
  entry: { value?: string; masked?: boolean; withheld?: boolean; fixed?: boolean },
): string {
  if (entry.masked) return `<span class="tc-val masked">${esc(t.masked)}</span>`;
  if (entry.withheld) return `<span class="tc-val masked">${esc(t.withheld)}</span>`;
  if (entry.value === undefined) return `<span class="mu">${esc(t.none)}</span>`;
  return `<span class="tc-val">${esc(entry.value)}</span>${entry.fixed ? ` <small class="mu">(${esc(t.fixed)})</small>` : ''}`;
}

const nodeName = (data: JourneyTraceability, id: string | undefined): string =>
  id === undefined ? '—' : (data.flow.nodes.find((node) => node.id === id)?.label ?? id);

/** Le bandeau du haut : les blocs dans l'ordre (liens de contrôle) et leurs entrées / sorties. */
function flowStrip(t: Text, data: JourneyTraceability, selected: string | undefined): string {
  const chip = (key: string, kind: 'in' | 'out'): string =>
    `<button type="button" class="tc-io ${kind}${selected === key ? ' sel' : ''}" data-action="jn-trace-pick" data-key="${esc(key)}" title="${esc(`${kind === 'out' ? t.output : t.input} ${key}`)}">${icon(kind === 'out' ? 'up' : 'down')}<span>${esc(key)}</span></button>`;
  const card = (node: TraceFlowNode): string => {
    if (node.kind === 'START' || node.kind === 'END')
      return `<li class="tc-term">${icon(node.kind === 'START' ? 'play' : 'check')}<span>${esc(node.kind === 'START' ? 'Début' : 'Fin')}</span></li>`;
    const ios =
      node.kind === 'BLOCK'
        ? `<span class="tc-ios">${node.outputs.map((key) => chip(key, 'out')).join('')}${node.inputs.map((key) => chip(key, 'in')).join('')}</span>`
        : '';
    return `<li class="tc-node ${node.kind.toLowerCase()}${node.loop ? ' in-loop' : ''}" data-tc-node="${esc(node.id)}"><span class="tc-card"><span class="tc-ic">${icon(node.kind === 'WAIT' ? 'history' : node.kind === 'LOOP' ? 'refresh' : node.kind === 'CONDITION' ? 'diamond' : 'cube')}</span><span class="tc-t"><b>${esc(node.label)}</b>${node.version !== undefined ? `<small class="mu">v${String(node.version)}</small>` : ''}</span></span>${ios}</li>`;
  };
  const nodes = data.flow.nodes.map(card).join('<li class="tc-arrow" aria-hidden="true">→</li>');
  const links = data.flow.edges.filter((edge) => edge.data && edge.data.length > 0);
  return `<section class="tc-flow" aria-labelledby="tc-flow-t"><h4 id="tc-flow-t">${esc(t.flowTitle)} <small class="tc-legend"><span class="tc-ctl"></span>${esc(t.controlLink)} <span class="tc-dl"></span>${esc(t.dataLink)}</small></h4><ol class="plain tc-strip">${nodes}</ol>${
    links.length > 0
      ? `<ul class="plain tc-links" aria-label="${esc(t.dataLinks)}">${links.map((edge) => `<li><span>${esc(nodeName(data, edge.from))}</span><span class="tc-dl" aria-hidden="true"></span><span>${esc(nodeName(data, edge.to))}</span> ${(edge.data ?? []).map((key) => `<code class="lib-key">${esc(key)}</code>`).join(' ')}</li>`).join('')}</ul>`
      : ''
  }</section>`;
}

function eventLabel(t: Text, event: TraceEvent): string {
  const base = t.origins[event.origin] ?? event.origin;
  return event.origin === 'USED' && event.use ? `${base} · ${t.uses2[event.use] ?? event.use}` : base;
}

function timeline(t: Text, state: DashboardState, data: JourneyTraceability, key: string): string {
  const events = data.events.filter((event) => event.key === key);
  if (events.length === 0) return `<p class="mu">${esc(t.noEvent)}</p>`;
  const flows = new Set(events.map((event) => event.flow));
  return `<ol class="plain tc-timeline">${events
    .map((event) => {
      const tone = event.origin === 'USED' ? 'use' : event.origin === 'OVERWRITE_REFUSED' ? 'ko' : 'prod';
      const block = event.block;
      const step =
        event.step !== undefined
          ? `${t.openStep(event.step)} · ${event.stepName?.split(' › ').at(-1) ?? ''}`
          : '';
      return `<li class="tc-ev ${tone}" data-tc-event="${esc(event.id ?? '')}"><span class="tc-dot" aria-hidden="true">${icon(tone === 'use' ? 'right' : tone === 'ko' ? 'alert' : 'play')}</span><span class="tc-when"><b>${esc(eventLabel(t, event))}</b><small>${esc(time(event.at, state.t.locale))}</small></span><div class="tc-evc"><div class="tc-evh"><b>${esc(block ?? event.flow)}</b>${event.node ? ` <small class="mu">${esc(event.node)}</small>` : ''}<span class="jn-chip ${event.origin === 'USED' ? 'info' : 'ok'}">${esc(event.origin === 'USED' ? t.input : t.output)}</span></div><small class="mu">${esc(step)}${event.loops?.length ? ` · ${event.loops.map((loop) => t.iteration(loop.id, loop.iteration)).join(' › ')}` : ''}${flows.size > 1 ? ` · ${event.flow}` : ''}${event.detail ? ` · ${event.detail}` : ''}</small><div>${esc(event.origin === 'USED' ? t.valueUsed : t.value)} : ${valueChip(t, event)}</div>${block ? `<button type="button" class="lnk" data-action="lib-open" data-block="${esc(block)}" data-sheet-tab="steps">${esc(t.openBlock)}</button>` : ''}</div></li>`;
    })
    .join('')}</ol>`;
}

/** Le graphe d'une donnée : ses producteurs à gauche, ses consommateurs à droite. */
function variableGraph(t: Text, variable: TraceVariable): string {
  const column = (items: { node: string; block: string }[], kind: string): string =>
    `<ul class="plain tc-col tc-col-${kind}">${items.map((item) => `<li><button type="button" class="lnk" data-action="lib-open" data-block="${esc(item.block)}" data-sheet-tab="steps">${icon('cube')}<span>${esc(item.block)}</span></button></li>`).join('') || `<li class="mu">${esc(t.none)}</li>`}</ul>`;
  return `<div class="tc-vgraph">${column(variable.producers, 'out')}<div class="tc-vkey"><span class="tc-dl" aria-hidden="true"></span><code class="lib-key">${esc(variable.key)}</code><span class="tc-dl" aria-hidden="true"></span></div>${column(variable.consumers, 'in')}</div>`;
}

function detailCard(
  t: Text,
  state: DashboardState,
  data: JourneyTraceability,
  variable: TraceVariable,
): string {
  const last = variable.observed?.occurrences.at(-1);
  const row = (label: string, value: string): string => `<dt>${esc(label)}</dt><dd>${value}</dd>`;
  return `<section class="tc-detail" aria-labelledby="tc-d-t"><h4 id="tc-d-t">${esc(t.detailTitle)}</h4><p class="tc-d-h">${icon('cube')}<b>${esc(variable.label ?? variable.key)}</b><span class="jn-chip ${variable.producers.length > 0 ? 'ok' : 'info'}">${esc(t.originsDef[variable.origin] ?? variable.origin)}</span></p><dl class="tc-dl2">${row(t.identifier, `<code>${esc(variable.key)}</code>`)}${row(t.type, `<span class="jn-chip info">${esc(variable.type)}</span>${variable.typeSource ? ` <small class="mu">${esc(variable.typeSource)}</small>` : ''}`)}${row(t.meaning, esc(variable.meaning ?? t.none))}${row(t.version, `v${String(variable.version)}`)}${row(t.provenance, variable.producers.map((producer) => `${esc(producer.block)}${producer.version !== undefined ? ` (v${String(producer.version)})` : ''}`).join(', ') || esc(t.none))}${row(t.lastValue, last ? valueChip(t, last) : `<span class="mu">${esc(variable.sensitive ? t.masked : t.noValue)}</span>`)}</dl><details open><summary>${esc(t.usedWhere(variable.consumers.length))}</summary><ul class="plain tc-uses">${variable.consumers.map((consumer) => `<li><button type="button" class="lnk" data-action="lib-open" data-block="${esc(consumer.block)}" data-sheet-tab="steps">${icon('cube')}<span>${esc(consumer.block)}${consumer.version !== undefined ? ` (v${String(consumer.version)})` : ''}</span></button>${consumer.contractKey ? ` <small class="mu">← ${esc(consumer.contractKey)}</small>` : ''}<span class="jn-chip info">${esc(t.input)}</span></li>`).join('') || `<li class="mu">${esc(t.none)}</li>`}</ul></details><details open><summary>${esc(t.metadata)}</summary><dl class="tc-dl2">${row(t.firstSeen, esc(time(variable.observed?.firstAt, state.t.locale)))}${row(t.lastSeen, esc(time(variable.observed?.lastAt, state.t.locale)))}${row(t.useCount, String(variable.observed?.uses ?? 0))}${row(t.status, `<span class="jn-chip ${statusTone(variable.status)}">${variable.status === 'CONFIRMED' ? icon('check') : ''}${esc(t.statuses[variable.status] ?? variable.status)}</span>`)}</dl><p class="tc-why"><b>${esc(t.why)} :</b> ${variable.justification.map((line) => esc(line)).join(' ; ') || esc(t.none)}</p>${variable.problems.length > 0 ? `<ul class="plain tc-problems" aria-label="${esc(t.problems)}">${variable.problems.map((problem) => `<li>${icon('alert')}<span>${esc(problem)}</span></li>`).join('')}</ul>` : ''}</details>${data.run ? `<small class="mu">${esc(t.run)} ${esc(data.run.run)}</small>` : ''}</section>`;
}

function correspondenceRow(t: Text, data: JourneyTraceability, entry: TraceCorrespondence): string {
  const from =
    entry.kind === 'DATA'
      ? `<span class="mu">${esc(t.data)}</span> <code class="lib-key">${esc(entry.fromKey ?? '')}</code>`
      : entry.from
        ? `${esc(nodeName(data, entry.from))} <code class="lib-key">${esc(entry.fromKey ?? '')}</code>`
        : `<span class="mu">${esc(t.none)}</span>`;
  const tone = entry.kind === 'MISSING' ? 'ko' : entry.kind === 'SUGGESTED' ? 'warn' : 'ok';
  return `<tr class="${entry.kind === 'MISSING' ? 'ko' : ''}"><td>${from}</td><td aria-hidden="true">→</td><td>${esc(nodeName(data, entry.to))} <code class="lib-key">${esc(entry.toKey)}</code></td><td><span class="jn-chip ${tone}">${esc(t.kinds[entry.kind] ?? entry.kind)}</span></td><td><small class="mu">${esc(entry.reason ?? '')}</small></td></tr>`;
}

/** Le graphe des dépendances : un arc par lien de données entre deux blocs, au-dessus du flux. */
function dependencyGraph(t: Text, data: JourneyTraceability): string {
  const nodes = data.flow.nodes.filter((node) => node.kind !== 'START' && node.kind !== 'END');
  const links = data.flow.edges.filter((edge) => edge.data && edge.data.length > 0);
  if (links.length === 0) return `<p class="mu">${esc(t.graphNone)}</p>`;
  const gap = 170;
  const x = (id: string): number => nodes.findIndex((node) => node.id === id) * gap + 80;
  const width = Math.max(nodes.length * gap, 320);
  const arcs = links
    .map((edge, index) => {
      const x1 = x(edge.from);
      const x2 = x(edge.to);
      if (x1 < 80 || x2 < 80) return '';
      const lift = 40 + (index % 3) * 26;
      const mid = (x1 + x2) / 2;
      return `<path class="tc-arc" d="M${String(x1)},150 Q${String(mid)},${String(150 - lift * 2)} ${String(x2)},150" marker-end="url(#tc-arrow)"></path><text x="${String(mid)}" y="${String(150 - lift - 6)}" text-anchor="middle" class="tc-arc-t">${esc((edge.data ?? []).join(', '))}</text>`;
    })
    .join('');
  const boxes = nodes
    .map(
      (node) =>
        `<g class="tc-g ${node.kind.toLowerCase()}"><rect x="${String(x(node.id) - 70)}" y="150" width="140" height="40" rx="8"></rect><text x="${String(x(node.id))}" y="174" text-anchor="middle">${esc(node.label.length > 20 ? `${node.label.slice(0, 19)}…` : node.label)}</text></g>`,
    )
    .join('');
  return `<p class="mu small">${esc(t.graphNote)}</p><div class="tc-svg-w"><svg class="tc-svg" viewBox="0 0 ${String(width)} 210" width="${String(width)}" height="210" role="img" aria-label="${esc(t.tabs.graph)}"><defs><marker id="tc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z"></path></marker></defs>${arcs}${boxes}</svg></div>`;
}

/** Le panneau de droite de la vue : la fiche de la donnée choisie (ou ce qu'il faut faire pour l'avoir). */
export function traceDetail(state: DashboardState, trace: TraceUi | undefined): string {
  const t = traceUiText(state);
  const data = trace?.data;
  if (!data) return `<p class="mu">${esc(t.loading)}</p>`;
  const query = trace.query.trim().toLowerCase();
  const list = data.variables.filter(
    (variable) =>
      !query ||
      variable.key.toLowerCase().includes(query) ||
      (variable.label ?? '').toLowerCase().includes(query),
  );
  const selected = data.variables.find((variable) => variable.key === trace.selected) ?? list[0];
  return selected ? detailCard(t, state, data, selected) : `<p class="mu">${esc(t.pick)}</p>`;
}

/** La vue complète. `stale` : le parcours a changé depuis le chargement. */
export function traceView(state: DashboardState, trace: TraceUi, stale: boolean): string {
  const t = traceUiText(state);
  const data = trace.data;
  const runs = data?.runs ?? [];
  const head = `<div class="tc-head"><label class="field tc-run"><span>${esc(t.run)}</span><select data-jn="trace.run"${runs.length === 0 ? ' disabled' : ''}>${runs.length === 0 ? `<option>${esc(t.runNone)}</option>` : runs.map((run) => `<option value="${esc(run.run)}"${data?.run?.run === run.run ? ' selected' : ''}>${esc(t.runLabel(new Date(run.createdAt).toLocaleString(state.t.locale), run.verdict, run.simulation === true))}</option>`).join('')}</select></label><button type="button" class="btn small" data-action="jn-trace-load"${trace.loading ? ' disabled' : ''}>${icon('refresh')}<span>${esc(t.load)}</span></button></div>`;
  if (trace.loading && !data)
    return `<div class="tc">${head}<p class="mu" role="status"><span class="spin" aria-hidden="true"></span> ${esc(t.loading)}</p></div>`;
  if (trace.error) return `<div class="tc">${head}<p class="err" role="alert">${esc(trace.error)}</p></div>`;
  if (!data)
    return `<div class="tc">${head}<p class="mu" role="status"><span class="spin" aria-hidden="true"></span> ${esc(t.loading)}</p></div>`;
  const banners = `${stale ? `<p class="notice warn" role="status">${icon('info')}<span>${esc(t.stale)}</span></p>` : ''}${data.state === 'NO_EXECUTION' ? `<p class="notice" role="status">${icon('info')}<span>${esc(t.noExecution)}</span></p>` : data.state === 'NO_TRACES' ? `<p class="notice warn" role="status">${icon('info')}<span>${esc(t.noTraces)}</span></p>` : ''}${data.notes.length > 0 ? `<p class="mu small">${esc(t.notes)} : ${data.notes.map((note) => esc(note)).join(' ; ')}</p>` : ''}`;
  const tabs = (['trace', 'vars', 'map', 'graph'] as const)
    .map(
      (tab) =>
        `<button type="button" role="tab" class="tc-tab" data-action="jn-trace-tab" data-tab="${tab}" aria-selected="${String(trace.tab === tab)}">${icon(tab === 'trace' ? 'link' : tab === 'vars' ? 'data' : tab === 'map' ? 'right' : 'merge')}<span>${esc(tab === 'vars' ? t.tabs.vars(data.variables.length) : t.tabs[tab])}</span></button>`,
    )
    .join('');
  const query = trace.query.trim().toLowerCase();
  const list = data.variables.filter(
    (variable) =>
      !query ||
      variable.key.toLowerCase().includes(query) ||
      (variable.label ?? '').toLowerCase().includes(query),
  );
  const selected = data.variables.find((variable) => variable.key === trace.selected) ?? list[0];
  let body = '';
  if (trace.tab === 'trace') {
    const left = `<section class="tc-list" aria-labelledby="tc-l-t"><h4 id="tc-l-t">${esc(t.variablesTitle)}</h4><label class="field"><span class="sr">${esc(t.search)}</span><input data-jn="trace.query" value="${esc(trace.query)}" placeholder="${esc(t.search)}" autocomplete="off" spellcheck="false"></label><ul class="plain tc-vars">${list
      .map(
        (variable) =>
          `<li><button type="button" class="tc-var${variable.key === selected?.key ? ' sel' : ''}" data-action="jn-trace-pick" data-key="${esc(variable.key)}" aria-pressed="${String(variable.key === selected?.key)}">${icon('cube')}<span class="tc-var-t"><b>${esc(variable.key)}</b><small class="mu">${esc(variable.type)}</small></span><span class="jn-chip ${statusTone(variable.status)}">${esc(t.statuses[variable.status] ?? variable.status)}</span></button></li>`,
      )
      .join('')}${list.length === 0 ? `<li class="mu">${esc(t.noVariable)}</li>` : ''}</ul></section>`;
    const center = selected
      ? `<section class="tc-center" aria-labelledby="tc-c-t"><div class="tc-c-h"><h4 id="tc-c-t">${icon('cube')}<span>${esc(t.traceOf(selected.key))}</span> <span class="jn-chip info">${esc(t.uses(selected.observed?.uses ?? 0))}</span></h4><span class="tc-switch" role="radiogroup"><button type="button" class="btn small${trace.center === 'timeline' ? ' primary' : ''}" role="radio" aria-checked="${String(trace.center === 'timeline')}" data-action="jn-trace-center" data-center="timeline">${esc(t.timeline)}</button><button type="button" class="btn small${trace.center === 'graph' ? ' primary' : ''}" role="radio" aria-checked="${String(trace.center === 'graph')}" data-action="jn-trace-center" data-center="graph">${esc(t.graphView)}</button></span></div>${trace.center === 'timeline' ? timeline(t, state, data, selected.key) : variableGraph(t, selected)}</section>`
      : `<section class="tc-center"><p class="mu">${esc(t.pick)}</p></section>`;
    // La fiche de la donnée est dans le panneau de droite (traceDetail), comme les propriétés d'un nœud.
    body = `<div class="tc-grid">${left}${center}</div>`;
  } else if (trace.tab === 'vars') {
    body = `<div class="jn-tbl-w"><table class="jn-tbl"><thead><tr><th scope="col">${esc(t.colKey)}</th><th scope="col">${esc(t.colType)}</th><th scope="col">${esc(t.colOrigin)}</th><th scope="col">${esc(t.colVersion)}</th><th scope="col">${esc(t.colProducers)}</th><th scope="col">${esc(t.colConsumers)}</th><th scope="col">${esc(t.colStatus)}</th></tr></thead><tbody>${data.variables
      .map(
        (variable) =>
          `<tr><td><button type="button" class="lnk" data-action="jn-trace-pick" data-key="${esc(variable.key)}" data-tab="trace"><code class="lib-key">${esc(variable.key)}</code></button></td><td>${esc(variable.type)}</td><td>${esc(t.originsDef[variable.origin] ?? variable.origin)}</td><td>v${String(variable.version)}</td><td>${esc(variable.producers.map((entry) => entry.block).join(', ') || t.none)}</td><td>${esc(variable.consumers.map((entry) => entry.block).join(', ') || t.none)}</td><td><span class="jn-chip ${statusTone(variable.status)}">${esc(t.statuses[variable.status] ?? variable.status)}</span></td></tr>`,
      )
      .join('')}</tbody></table></div>`;
  } else if (trace.tab === 'map') {
    body =
      data.correspondences.length === 0
        ? `<p class="mu">${esc(t.noMap)}</p>`
        : `<div class="jn-tbl-w"><table class="jn-tbl"><thead><tr><th scope="col">${esc(t.colFrom)}</th><th></th><th scope="col">${esc(t.colTo)}</th><th scope="col">${esc(t.colKind)}</th><th scope="col">${esc(t.colReason)}</th></tr></thead><tbody>${data.correspondences.map((entry) => correspondenceRow(t, data, entry)).join('')}</tbody></table></div>`;
  } else body = dependencyGraph(t, data);
  return `<div class="tc">${head}${banners}${flowStrip(t, data, selected?.key)}<div class="tc-tabs" role="tablist" aria-label="${esc(t.view)}">${tabs}</div><div class="tc-body">${body}</div></div>`;
}

export const TRACE_VIEW_CSS = `
.tc{display:flex;flex-direction:column;gap:10px;min-width:0;padding:10px 12px;container-type:inline-size}
.tc-head{display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px}
.tc-run{min-width:240px;margin:0}
.tc-flow{border:1px solid var(--qa-color-border);border-radius:10px;padding:8px 10px;min-width:0}
.tc-flow h4{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:0 0 6px;font-size:13px}
.tc-legend{display:inline-flex;align-items:center;gap:6px;font-weight:400;color:var(--qa-color-muted)}
.tc-ctl{display:inline-block;width:22px;border-top:2px solid var(--qa-color-text)}
.tc-dl{display:inline-block;width:22px;border-top:2px dashed var(--qa-color-data,#2F7DE1)}
.tc .tc-strip{display:flex;flex-direction:row;flex-wrap:nowrap;align-items:flex-start;gap:6px;overflow-x:auto;padding-bottom:4px}
.tc-arrow{align-self:center;color:var(--qa-color-muted)}
.tc-term{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border:1px solid var(--qa-color-primary);border-radius:999px;font-size:12px;align-self:center;white-space:nowrap}
.tc-node{display:flex;flex-direction:column;gap:4px;flex:none;width:170px}
.tc-card{display:flex;align-items:center;gap:6px;padding:6px 8px;border:1px solid var(--jn-node-bd,var(--qa-color-border));border-radius:8px;background:var(--jn-node-bg,var(--qa-color-surface))}
.tc-node.wait .tc-card{border-color:var(--jn-wait);background:var(--jn-wait-soft)}
.tc-node.loop .tc-card,.tc-node.in-loop .tc-card{border-color:var(--jn-loop);background:var(--jn-loop-soft)}
.tc-node.in-loop .tc-card{border-style:dashed}
.tc-t{display:flex;flex-direction:column;min-width:0}
.tc-t b{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tc-ios{display:flex;flex-direction:column;gap:3px}
.tc-io{display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:2px 6px;border-radius:6px;font:inherit;font-size:11px;cursor:pointer;border:1px solid currentColor;background:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tc-io.out{color:var(--qa-color-data,#2F7DE1)}
.tc-io.in{color:var(--jn-loop)}
.tc-io.sel{background:color-mix(in srgb,currentColor 12%,transparent);font-weight:600}
.tc-io svg{width:11px;height:11px;flex:none}
.tc-links{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:6px;font-size:12px}
.tc-links li{display:inline-flex;align-items:center;gap:6px}
.tc-tabs{display:flex;flex-wrap:wrap;gap:6px}
.tc-tab{display:inline-flex;align-items:center;gap:5px;padding:6px 10px;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-surface);font:inherit;font-size:12.5px;cursor:pointer}
.tc-tab[aria-selected="true"]{background:var(--qa-color-primary);border-color:var(--qa-color-primary);color:#fff}
.tc-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;align-items:start}
@container (min-width:600px){.tc-grid{grid-template-columns:minmax(200px,240px) minmax(0,1fr)}}
.jn-side .tc-detail{border:0;padding:0}
.tc-list,.tc-center,.tc-detail{border:1px solid var(--qa-color-border);border-radius:10px;padding:8px 10px;min-width:0}
.tc-list h4,.tc-center h4,.tc-detail h4{margin:0 0 6px;font-size:13px}
.tc-vars{display:flex;flex-direction:column;gap:4px;max-height:420px;overflow:auto}
.tc-var{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:2px 6px;width:100%;padding:6px 8px;border:1px solid transparent;border-radius:8px;background:none;font:inherit;text-align:left;cursor:pointer}
.tc-var .jn-chip{grid-column:2;justify-self:start;font-size:10.5px}
.tc-var.sel{border-color:var(--qa-color-primary);background:var(--qa-color-primary-soft)}
.tc-var-t{display:flex;flex-direction:column;flex:1;min-width:0}
.tc-var-t b{font-size:12px;overflow-wrap:anywhere}
.tc-c-h{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px}
.tc-c-h h4{display:flex;align-items:center;gap:6px}
.tc-switch{display:inline-flex;gap:4px}
.tc-timeline{display:flex;flex-direction:column;gap:8px;margin-top:6px;border-left:2px solid var(--qa-color-border);margin-left:10px;padding-left:12px}
.tc-ev{display:grid;grid-template-columns:auto 110px minmax(0,1fr);gap:8px;align-items:start;position:relative}
@container (max-width:520px){.tc-ev{grid-template-columns:auto minmax(0,1fr)}.tc-ev .tc-evc{grid-column:2}}
.tc-dot{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:999px;margin-left:-24px;background:var(--qa-color-primary);color:#fff}
.tc-ev.use .tc-dot{background:#7C3AED}
.tc-ev.ko .tc-dot{background:var(--qa-color-danger)}
.tc-dot svg{width:12px;height:12px}
.tc-when{display:flex;flex-direction:column;font-size:12px}
.tc-evc{border:1px solid var(--qa-color-border);border-radius:8px;padding:6px 8px;display:flex;flex-direction:column;gap:3px;font-size:12px;min-width:0}
.tc-evh{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.tc-evh .jn-chip{margin-left:auto}
.tc-val{display:inline-block;padding:0 6px;border-radius:6px;background:color-mix(in srgb,var(--qa-color-data,#2F7DE1) 12%,transparent);font-family:var(--qa-font-mono,ui-monospace,monospace);font-size:12px;word-break:break-all}
.tc-val.masked{background:var(--qa-color-warning-soft);font-family:inherit}
.tc-val svg{width:11px;height:11px}
.tc-d-h{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 6px}
.tc-dl2{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 10px;margin:0 0 6px;font-size:12px}
.tc-dl2 dt{color:var(--qa-color-muted)}
.tc-dl2 dd{margin:0;min-width:0;word-break:break-word}
.tc-detail details{margin-top:6px}
.tc-detail summary{cursor:pointer;font-weight:600;font-size:12.5px}
.tc-uses{display:flex;flex-direction:column;gap:4px;margin-top:4px;font-size:12px}
.tc-uses li{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.tc-uses .jn-chip{margin-left:auto}
.tc-why{font-size:12px;margin:4px 0}
.tc-problems{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--qa-color-danger)}
.tc-problems li{display:flex;gap:4px;align-items:flex-start}
.tc-vgraph{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:10px;align-items:center;margin-top:8px}
.tc-col{display:flex;flex-direction:column;gap:6px}
.tc-col-in{align-items:flex-end}
.tc-vkey{display:flex;align-items:center;gap:6px}
.tc-svg-w{overflow-x:auto}
.tc-svg .tc-arc{fill:none;stroke:var(--qa-color-data,#2F7DE1);stroke-width:1.6;stroke-dasharray:5 4}
.tc-svg marker path{fill:var(--qa-color-data,#2F7DE1)}
.tc-svg .tc-arc-t{font-size:11px;fill:var(--qa-color-data,#2F7DE1)}
.tc-svg rect{fill:var(--qa-color-surface);stroke:var(--qa-color-primary)}
.tc-svg .loop rect{stroke:#7C3AED}
.tc-svg .wait rect{stroke:var(--qa-color-warning)}
.tc-svg text{font-size:11.5px;fill:var(--qa-color-text)}
`;
