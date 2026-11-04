import type {
  ContractField,
  LibraryBlockActivity,
  LibraryBlockDetails,
  LibraryBlockView,
} from '../core/contracts.js';
import type { JourneyPreview } from '../core/journey-loop.js';
import { can } from './dashboard-access.js';
import { icon } from './dashboard-parts.js';
import type { DashboardState } from './dashboard-view.js';
import { esc } from './view.js';

/**
 * LA FICHE D'UN BLOC, ce qui s'ajoute aux onglets existants : l'en-tête d'actions (Prévisualiser, Éditer,
 * Dupliquer, Ajouter au parcours), la vue d'ensemble en cartes, l'onglet Traçabilité et la compatibilité avec
 * le parcours ouvert. Trois couches toujours séparées : la donnée DÉCLARÉE (contrat), DÉTECTÉE (les étapes) et
 * OBSERVÉE (la trace d'une exécution réelle qui a rejoué le bloc). Rien n'est inventé : sans exécution, rien
 * n'est « observé » ; une donnée citée (`${testData:…}`) est une entrée tant qu'aucune étape ne la produit.
 */
export interface SheetInsight {
  /** L'activité réelle (dernière exécution, trace) ; `loading` : en cours de lecture. */
  activity?: LibraryBlockActivity;
  activityLoading?: boolean;
  activityError?: string;
  /** La donnée choisie dans l'onglet Traçabilité : `input:clé` ou `output:clé`. */
  traceKey?: string;
  /** « Dupliquer » : le formulaire ouvert. */
  duplicate?: { name: string; description: string; busy?: boolean; error?: string };
  /** « Prévisualiser » : l'aperçu statique réel d'un parcours fait de ce seul bloc. */
  preview?: { busy?: boolean; error?: string; data?: JourneyPreview };
}

const FR = {
  tabTrace: 'Traçabilité',
  preview: 'Prévisualiser',
  previewHint: 'Analyse statique du bloc seul : rien n’est exécuté.',
  previewBusy: 'Analyse…',
  previewTitle: 'Prévisualisation (analyse statique)',
  previewNone: 'Aucune étape à analyser.',
  previewNote:
    'Un bloc ne s’exécute pas seul : ajoutez-le à un parcours, puis lancez une exécution de simulation du parcours dans un environnement de test.',
  edit: 'Éditer',
  editHint: 'Modifier le contrat du bloc (entrées, sorties, conditions).',
  duplicate: 'Dupliquer',
  duplicateTitle: 'Dupliquer le bloc',
  duplicateName: 'Nom de la copie',
  duplicateDescription: 'Description (facultative)',
  duplicateDo: 'Créer la copie',
  duplicateNote:
    'La copie reprend les étapes, le jeu de données, le contrat et les déclarations des données ; elle commence en version 1. Le bloc d’origine ne change pas.',
  copyName: (name: string) => `${name} (copie)`,
  addToJourney: 'Ajouter au parcours',
  cancel: 'Annuler',
  close: 'Fermer',
  info: 'Informations générales',
  description: 'Description',
  noDescription: 'Aucune description.',
  inputs: (count: number) => `Entrées (${String(count)})`,
  outputs: (count: number) => `Sorties (${String(count)})`,
  add: 'Ajouter',
  noInputs: 'Aucune entrée : le bloc ne lit aucune donnée fournie par l’amont.',
  noOutputs: 'Aucune sortie exposée.',
  required: 'obligatoire',
  traceTitle: 'Traçabilité des données',
  traceOpen: 'Voir la traçabilité',
  lastRun: 'Dernière exécution',
  lastRunNone: 'Aucune exécution réelle n’a encore rejoué ce bloc.',
  lastRunLoading: 'Lecture des exécutions…',
  lastRunScanned: (count: number) => `${String(count)} exécution(s) récente(s) lue(s).`,
  verdicts: {
    PASSED: 'Succès',
    FAILED: 'Échec',
    INCONCLUSIVE: 'Non concluant',
    CANCELLED: 'Annulée',
  } as Record<string, string>,
  on: (date: string) => `Le ${date}`,
  duration: (ms: number) =>
    ms >= 60_000
      ? `${String(Math.floor(ms / 60_000))} min ${String(Math.round((ms % 60_000) / 1000))} s`
      : `${String(Math.round(ms / 1000))} s`,
  viaScenario: (names: string) => `Scénario : ${names}`,
  viaSimulation: (journey: string) => `Exécution de simulation du parcours « ${journey} »`,
  openReport: 'Voir le rapport',
  // Traçabilité
  graphLabel: 'Entrées, bloc et sorties, d’après le contrat',
  pickHint: 'Choisissez une donnée pour voir sa provenance.',
  declared: 'Déclarée',
  detected: 'Détectée',
  observed: 'Observée',
  declaredContract: 'Dans le contrat déclaré par une personne.',
  derivedContract: 'Dans le contrat déduit des étapes du bloc.',
  notInContract: 'Absente du contrat.',
  detection: { CONFIRMED: 'Confirmée', PROBABLE: 'Probable', UNKNOWN: 'Inconnue' } as Record<string, string>,
  origin: {
    INPUT: 'Entrée fournie par l’amont (jamais générée par ce bloc)',
    GENERATED: 'Générée par le bloc au rejeu',
    CAPTURED: 'Capturée pendant le rejeu',
    DATA: 'Valeur fixe du jeu de données du bloc (non générée)',
    LITERAL: 'Valeur saisie telle quelle dans une étape',
  } as Record<string, string>,
  originLabel: 'Provenance',
  generator: (name: string) => `générateur « ${name} »`,
  captureSource: (source: string) => `source : ${source}`,
  typeLabel: 'Type',
  typeSource: { DECLARED: 'déclaré', INFERRED: 'proposé', DEFAULT: 'par défaut' } as Record<string, string>,
  meaning: 'Sens métier',
  version: (version: number) => `définition v${String(version)}`,
  stepsLabel: 'Étapes',
  produces: 'produite par',
  reads: 'lue par',
  noStep: 'aucune étape du bloc',
  stepN: (position: number) => `étape ${String(position)}`,
  scenarioStep: (position: number) => `étape ${String(position)} du scénario`,
  producers: 'Blocs qui la produisent',
  consumers: 'Blocs qui la lisent',
  scenarios: 'Scénarios qui rejouent ce bloc',
  none: 'Aucun.',
  observedNone: 'Rien d’observé : aucune exécution réelle n’a rejoué ce bloc.',
  observedEmpty: (run: string) => `L’exécution ${run} n’a rapporté aucun événement pour cette donnée.`,
  observedIn: (run: string, date: string) => `Exécution ${run} du ${date}`,
  events: {
    GENERATED: 'Génération',
    CAPTURED: 'Capture',
    TRANSFORMED: 'Transformation',
    ITERATION: 'Variable d’itération',
    USED: 'Utilisation',
    OVERWRITE_REFUSED: 'Écrasement refusé',
  } as Record<string, string>,
  uses: { ASSIGN: 'saisie', READ: 'lecture', VALIDATE: 'vérification' } as Record<string, string>,
  masked: 'masquée',
  withheld: 'non conservée (rétention)',
  noValue: 'sans valeur',
  // Compatibilité
  compatTitle: 'Compatibilité avec le parcours ouvert',
  compatEmpty: 'Le parcours ouvert ne contient encore aucun bloc : les entrées devront être fournies.',
  compatNoInputs: 'Ce bloc ne demande aucune entrée.',
  compatFrom: (blocks: string) => `fournie par ${blocks}`,
  compatAmbiguous: (blocks: string) => `ambiguë : plusieurs blocs la produisent (${blocks})`,
  compatData: 'fournie par le jeu de données du bloc',
  compatMissing: 'manquante : aucun bloc du parcours ne la produit',
  compatOptional: 'facultative, non fournie',
  compatVersion: (current: number, pinned: number) =>
    `le parcours utilise déjà la v${String(pinned)} de ce bloc (bibliothèque : v${String(current)})`,
  compatNote:
    'Indicatif : après l’ajout, la vérification du parcours propose les correspondances à accepter explicitement.',
};
type Text = typeof FR;

const EN: Text = {
  tabTrace: 'Traceability',
  preview: 'Preview',
  previewHint: 'Static analysis of the block alone: nothing is run.',
  previewBusy: 'Analysing…',
  previewTitle: 'Preview (static analysis)',
  previewNone: 'No step to analyse.',
  previewNote:
    'A block never runs alone: add it to a journey, then start a simulation run of the journey in a test environment.',
  edit: 'Edit',
  editHint: 'Edit the block contract (inputs, outputs, conditions).',
  duplicate: 'Duplicate',
  duplicateTitle: 'Duplicate the block',
  duplicateName: 'Name of the copy',
  duplicateDescription: 'Description (optional)',
  duplicateDo: 'Create the copy',
  duplicateNote:
    'The copy keeps the steps, the data set, the contract and the data declarations; it starts at version 1. The original block does not change.',
  copyName: (name) => `${name} (copy)`,
  addToJourney: 'Add to journey',
  cancel: 'Cancel',
  close: 'Close',
  info: 'General information',
  description: 'Description',
  noDescription: 'No description.',
  inputs: (count) => `Inputs (${String(count)})`,
  outputs: (count) => `Outputs (${String(count)})`,
  add: 'Add',
  noInputs: 'No input: the block reads no data from upstream.',
  noOutputs: 'No exposed output.',
  required: 'required',
  traceTitle: 'Data traceability',
  traceOpen: 'Open traceability',
  lastRun: 'Last run',
  lastRunNone: 'No real run has replayed this block yet.',
  lastRunLoading: 'Reading the runs…',
  lastRunScanned: (count) => `${String(count)} recent run(s) read.`,
  verdicts: { PASSED: 'Passed', FAILED: 'Failed', INCONCLUSIVE: 'Inconclusive', CANCELLED: 'Cancelled' },
  on: (date) => `On ${date}`,
  duration: (ms) =>
    ms >= 60_000
      ? `${String(Math.floor(ms / 60_000))} min ${String(Math.round((ms % 60_000) / 1000))} s`
      : `${String(Math.round(ms / 1000))} s`,
  viaScenario: (names) => `Scenario: ${names}`,
  viaSimulation: (journey) => `Simulation run of the journey “${journey}”`,
  openReport: 'Open the report',
  graphLabel: 'Inputs, block and outputs, from the contract',
  pickHint: 'Pick a data item to see where it comes from.',
  declared: 'Declared',
  detected: 'Detected',
  observed: 'Observed',
  declaredContract: 'In the contract declared by a person.',
  derivedContract: 'In the contract derived from the block steps.',
  notInContract: 'Not in the contract.',
  detection: { CONFIRMED: 'Confirmed', PROBABLE: 'Probable', UNKNOWN: 'Unknown' },
  origin: {
    INPUT: 'Input provided upstream (never generated by this block)',
    GENERATED: 'Generated by the block at replay',
    CAPTURED: 'Captured during the replay',
    DATA: 'Fixed value of the block data set (not generated)',
    LITERAL: 'Value typed as is by a step',
  },
  originLabel: 'Provenance',
  generator: (name) => `generator “${name}”`,
  captureSource: (source) => `source: ${source}`,
  typeLabel: 'Type',
  typeSource: { DECLARED: 'declared', INFERRED: 'suggested', DEFAULT: 'default' },
  meaning: 'Business meaning',
  version: (version) => `definition v${String(version)}`,
  stepsLabel: 'Steps',
  produces: 'produced by',
  reads: 'read by',
  noStep: 'no step of the block',
  stepN: (position) => `step ${String(position)}`,
  scenarioStep: (position) => `scenario step ${String(position)}`,
  producers: 'Blocks producing it',
  consumers: 'Blocks reading it',
  scenarios: 'Scenarios replaying this block',
  none: 'None.',
  observedNone: 'Nothing observed: no real run has replayed this block.',
  observedEmpty: (run) => `The run ${run} reported no event for this data item.`,
  observedIn: (run, date) => `Run ${run} on ${date}`,
  events: {
    GENERATED: 'Generation',
    CAPTURED: 'Capture',
    TRANSFORMED: 'Transformation',
    ITERATION: 'Iteration variable',
    USED: 'Use',
    OVERWRITE_REFUSED: 'Overwrite refused',
  },
  uses: { ASSIGN: 'typed', READ: 'read', VALIDATE: 'checked' },
  masked: 'masked',
  withheld: 'not kept (retention)',
  noValue: 'no value',
  compatTitle: 'Compatibility with the open journey',
  compatEmpty: 'The open journey has no block yet: the inputs will have to be provided.',
  compatNoInputs: 'This block needs no input.',
  compatFrom: (blocks) => `provided by ${blocks}`,
  compatAmbiguous: (blocks) => `ambiguous: several blocks produce it (${blocks})`,
  compatData: 'provided by the block data set',
  compatMissing: 'missing: no block of the journey produces it',
  compatOptional: 'optional, not provided',
  compatVersion: (current, pinned) =>
    `the journey already uses v${String(pinned)} of this block (library: v${String(current)})`,
  compatNote: 'Indicative: once added, the journey check proposes the correspondences to accept explicitly.',
};

export const insightText = (state: DashboardState): Text => (state.t.locale === 'en' ? EN : FR);

const fieldsOf = (block: LibraryBlockView, direction: 'input' | 'output'): ContractField[] => {
  const fields = block.contract.fields;
  if (fields) return direction === 'input' ? fields.inputs : fields.outputs.filter((field) => field.exposed);
  // Un ancien contrat sans description des données : seulement les clés (rien n'est supposé).
  return (direction === 'input' ? block.contract.inputs : block.contract.outputs).map((entry) => ({
    id: `${block.id}:${direction}:${entry.key}`,
    direction,
    key: entry.key,
    type: 'text',
    typeSource: 'DEFAULT',
    required: 'required' in entry ? entry.required : false,
    origin: direction === 'input' ? 'INPUT' : 'DATA',
    version: 1,
    detection: 'UNKNOWN',
    evidence: [],
    steps: [],
    exposed: true,
  }));
};

export const inputFields = (block: LibraryBlockView): ContractField[] => fieldsOf(block, 'input');
export const outputFields = (block: LibraryBlockView): ContractField[] => fieldsOf(block, 'output');

const date = (state: DashboardState, iso?: string): string =>
  iso ? new Date(iso).toLocaleString(state.t.locale) : '—';

// ── En-tête d'actions ──────────────────────────────────────────────────────────────────────────

/** Les actions de la fiche : seulement celles que le bloc et les droits permettent, toutes réelles. */
export function sheetActions(state: DashboardState, block: LibraryBlockView, insight: SheetInsight): string {
  const x = insightText(state);
  const publish = can(state, 'PUBLISH') && state.project?.state !== 'ARCHIVED';
  const busy = insight.preview?.busy === true;
  return `<div class="lib-acts" role="toolbar" aria-label="${esc(block.name)}"><button class="btn small" data-action="lib-preview" title="${esc(x.previewHint)}" ${busy ? 'disabled aria-busy="true"' : ''}>${icon('eye')}<span>${esc(busy ? x.previewBusy : x.preview)}</span></button>${
    publish
      ? `<button class="btn small" data-action="lib-edit" data-block="${esc(block.name)}" title="${esc(x.editHint)}">${icon('edit')}<span>${esc(x.edit)}</span></button><button class="btn small" data-action="lib-dup-open" aria-expanded="${String(insight.duplicate !== undefined)}">${icon('copy')}<span>${esc(x.duplicate)}</span></button><button class="btn small primary" data-action="lib-part-add" data-block="${esc(block.name)}">${icon('plus')}<span>${esc(x.addToJourney)}</span></button>`
      : ''
  }</div>`;
}

/** Le formulaire « Dupliquer » (nom libre, description facultative). */
export function duplicateForm(state: DashboardState, insight: SheetInsight): string {
  const form = insight.duplicate;
  if (!form) return '';
  const x = insightText(state);
  return `<form class="col lib-dup" data-action="lib-dup-save" aria-labelledby="lib-dup-t"><h3 id="lib-dup-t" class="section-t">${esc(x.duplicateTitle)}</h3><p class="mu small">${esc(x.duplicateNote)}</p><label class="field"><span>${esc(x.duplicateName)}</span><input data-lib="dup.name" value="${esc(form.name)}" maxlength="80" required autocomplete="off"></label><label class="field"><span>${esc(x.duplicateDescription)}</span><input data-lib="dup.description" value="${esc(form.description)}" maxlength="500" autocomplete="off"></label>${form.error ? `<p class="err" role="alert">${esc(form.error)}</p>` : ''}<div class="form-acts start"><button type="submit" class="btn small primary"${form.busy ? ' disabled aria-busy="true"' : ''}>${esc(x.duplicateDo)}</button><button type="button" class="btn small ghost" data-action="lib-dup-cancel">${esc(x.cancel)}</button></div></form>`;
}

/** L'aperçu statique (le parcours fait de ce seul bloc), tel que le serveur l'a analysé. */
export function previewBox(state: DashboardState, insight: SheetInsight): string {
  const preview = insight.preview;
  if (!preview || preview.busy) return '';
  const x = insightText(state);
  const close = `<button class="btn small ghost icon-only" data-action="lib-preview-close" aria-label="${esc(x.close)}" title="${esc(x.close)}">✕</button>`;
  if (preview.error)
    return `<section class="lib-prev" aria-labelledby="lib-prev-t"><div class="lib-col-h"><h3 id="lib-prev-t">${esc(x.previewTitle)}</h3>${close}</div><p class="err" role="alert">${esc(preview.error)}</p></section>`;
  const data = preview.data;
  const steps = data?.paths[0]?.steps ?? [];
  const rows = steps
    .map(
      (step) =>
        `<li><b>${esc(step.label)}</b>${step.inputs.length > 0 ? `<ul class="plain tight">${step.inputs.map((input) => `<li><code class="lib-key">${esc(input.key)}</code> <small class="mu">${esc(input.source === 'MISSING' ? x.compatMissing : input.source)}</small></li>`).join('')}</ul>` : ''}${step.outputs.length > 0 ? `<p class="small">${step.outputs.map((output) => `<code class="lib-key">${esc(output.key)}</code>`).join(' ')}</p>` : ''}${step.errors.map((error) => `<p class="err small">${esc(error)}</p>`).join('')}</li>`,
    )
    .join('');
  return `<section class="lib-prev" aria-labelledby="lib-prev-t"><div class="lib-col-h"><h3 id="lib-prev-t">${esc(x.previewTitle)}</h3>${close}</div>${(data?.errors ?? []).map((error) => `<p class="err small">${esc(error)}</p>`).join('')}${rows ? `<ul class="plain lib-prev-steps">${rows}</ul>` : `<p class="mu">${esc(x.previewNone)}</p>`}<p class="mu small">${esc(x.previewNote)}</p></section>`;
}

// ── Vue d'ensemble ─────────────────────────────────────────────────────────────────────────────

function fieldRow(field: ContractField, x: Text): string {
  return `<li class="lib-frow"><span class="lib-ftype" aria-hidden="true">${field.type === 'date' ? icon('history') : 'T'}</span><span class="lib-fname"><code class="lib-key">${esc(field.key)}</code>${field.label || field.meaning ? `<small class="mu">${esc(field.label ?? field.meaning ?? '')}</small>` : ''}</span><span class="lib-tag">${esc(field.type)}</span>${field.direction === 'input' && field.required ? `<span class="lib-req" title="${esc(x.required)}" aria-label="${esc(x.required)}">*</span>` : ''}</li>`;
}

function miniGraph(state: DashboardState, block: LibraryBlockView): string {
  const x = insightText(state);
  const inputs = inputFields(block);
  const outputs = outputFields(block);
  const node = (field: ContractField): string =>
    `<button class="lib-tnode ${field.direction}" data-action="lib-trace-pick" data-key="${esc(`${field.direction}:${field.key}`)}">${esc(field.key)}<small>${esc(field.direction === 'input' ? state.t.lib.inputsLabel : state.t.lib.outputsLabel)}</small></button>`;
  return `<figure class="lib-tgraph" aria-label="${esc(x.graphLabel)}"><div class="lib-tcol">${inputs.length > 0 ? inputs.map(node).join('') : `<small class="mu">${esc(x.none)}</small>`}</div><span class="lib-tarrow" aria-hidden="true">→</span><div class="lib-tcol mid"><span class="lib-tnode self">${icon('cube')}${esc(block.name)}<small>${esc(state.t.lib.version(block.version))}</small></span></div><span class="lib-tarrow" aria-hidden="true">→</span><div class="lib-tcol">${outputs.length > 0 ? outputs.map(node).join('') : `<small class="mu">${esc(x.none)}</small>`}</div></figure>`;
}

function lastRunCard(state: DashboardState, insight: SheetInsight): string {
  const x = insightText(state);
  const projectId = state.project?.id ?? '';
  let body: string;
  if (insight.activityLoading) body = `<p class="mu small" role="status">${esc(x.lastRunLoading)}</p>`;
  else if (insight.activityError)
    body = `<p class="err small" role="alert">${esc(insight.activityError)}</p>`;
  else if (!insight.activity?.last)
    body = `<p class="mu small">${esc(x.lastRunNone)}</p>${insight.activity ? `<p class="mu small">${esc(x.lastRunScanned(insight.activity.scanned))}</p>` : ''}`;
  else {
    const last = insight.activity.last;
    const tone = last.verdict === 'PASSED' ? 'ok' : last.verdict === 'FAILED' ? 'ko' : 'warn';
    body = `<p><span class="lib-state ${tone}">${esc(x.verdicts[last.verdict] ?? last.verdict)}</span></p><p class="small">${icon('history')} ${esc(x.on(date(state, last.createdAt)))}</p>${last.durationMs !== undefined ? `<p class="small">${esc(x.duration(last.durationMs))}</p>` : ''}<p class="mu small">${esc(last.simulation ? x.viaSimulation(last.simulation.journey) : x.viaScenario((last.scenarios ?? []).join(', ') || '—'))}</p><button class="btn small" data-action="open-run" data-project="${esc(projectId)}" data-run="${esc(last.run)}">${esc(x.openReport)}</button>`;
  }
  return `<section class="lib-ocard" aria-labelledby="lib-last-t"><h4 id="lib-last-t">${icon('executions')}<span>${esc(x.lastRun)}</span></h4>${body}</section>`;
}

/** La vue d'ensemble en cartes : informations, description, entrées, sorties, traçabilité, dernière exécution. */
export function overviewCards(
  state: DashboardState,
  block: LibraryBlockView,
  info: string,
  insight: SheetInsight,
  publish: boolean,
): string {
  const x = insightText(state);
  const inputs = inputFields(block);
  const outputs = outputFields(block);
  const groups = block.groups ?? [];
  const add = (tab: 'inputs' | 'outputs'): string =>
    publish
      ? `<button class="btn small ghost" data-action="${tab === 'outputs' ? 'lib-output-open' : 'lib-sheet-tab'}" data-tab="${tab}">${icon('plus')}<span>${esc(x.add)}</span></button>`
      : '';
  return `<div class="lib-ogrid">
<section class="lib-ocard" aria-labelledby="lib-info-t"><h4 id="lib-info-t">${icon('info')}<span>${esc(x.info)}</span></h4>${info}</section>
<section class="lib-ocard" aria-labelledby="lib-desc-t"><h4 id="lib-desc-t">${icon('editor')}<span>${esc(x.description)}</span></h4>${block.description ? `<p>${esc(block.description)}</p>` : `<p class="mu">${esc(x.noDescription)}</p>`}${groups.length > 0 ? `<p class="lib-tags">${groups.map((group) => `<span class="lib-tag">${esc(group.name)}</span>`).join('')}</p>` : ''}</section>
<section class="lib-ocard" aria-labelledby="lib-in-t"><div class="lib-col-h"><h4 id="lib-in-t">${icon('down')}<span>${esc(x.inputs(inputs.length))}</span></h4>${add('inputs')}</div>${inputs.length > 0 ? `<ul class="plain lib-fields">${inputs.map((field) => fieldRow(field, x)).join('')}</ul>` : `<p class="mu small">${esc(x.noInputs)}</p>`}</section>
<section class="lib-ocard" aria-labelledby="lib-out-t"><div class="lib-col-h"><h4 id="lib-out-t">${icon('up')}<span>${esc(x.outputs(outputs.length))}</span></h4>${add('outputs')}</div>${outputs.length > 0 ? `<ul class="plain lib-fields">${outputs.map((field) => fieldRow(field, x)).join('')}</ul>` : `<p class="mu small">${esc(x.noOutputs)}</p>`}</section>
<section class="lib-ocard wide" aria-labelledby="lib-tr-t"><div class="lib-col-h"><h4 id="lib-tr-t">${icon('traceability')}<span>${esc(x.traceTitle)}</span></h4><button class="btn small ghost" data-action="lib-sheet-tab" data-tab="traceability">${esc(x.traceOpen)}</button></div>${miniGraph(state, block)}</section>
${lastRunCard(state, insight)}
</div>`;
}

// ── Traçabilité ────────────────────────────────────────────────────────────────────────────────

/** L'onglet Traçabilité : le graphe du contrat, puis la donnée choisie en trois couches. */
export function traceabilityTab(
  state: DashboardState,
  block: LibraryBlockView,
  details: LibraryBlockDetails | undefined,
  insight: SheetInsight,
): string {
  const x = insightText(state);
  const inputs = inputFields(block);
  const outputs = outputFields(block);
  const all = [...outputs, ...inputs];
  const picked =
    all.find((field) => `${field.direction}:${field.key}` === insight.traceKey) ?? outputs[0] ?? inputs[0];
  const graph = miniGraph(state, block).replace(
    picked ? `data-key="${esc(`${picked.direction}:${picked.key}`)}"` : '\0',
    picked ? `data-key="${esc(`${picked.direction}:${picked.key}`)}" aria-pressed="true"` : '\0',
  );
  if (!picked) return `${graph}<p class="mu">${esc(x.none)}</p>`;
  const others = (state.lib.blocks ?? []).filter((entry) => entry.name !== block.name);
  const producers = others.filter((entry) =>
    entry.contract.outputs.some((output) => output.key === picked.key),
  );
  const consumers = others.filter((entry) => entry.contract.inputs.some((input) => input.key === picked.key));
  const stepLabel = (position: number): string => {
    const step = details?.steps.find((entry) => entry.position === position);
    return `${x.stepN(position)}${step ? ` · ${step.label.slice(0, 80)}` : ''}`;
  };
  const steps =
    picked.steps.length > 0
      ? `<ul class="plain tight">${picked.steps.map((position) => `<li><button class="lnk" data-action="lib-sheet-tab" data-tab="steps">${esc(stepLabel(position))}</button></li>`).join('')}</ul>`
      : `<p class="mu small">${esc(x.noStep)}</p>`;
  const origin = `${x.origin[picked.origin] ?? picked.origin}${picked.generator ? ` · ${x.generator(picked.generator)}` : ''}${picked.capture ? ` · ${x.captureSource(picked.capture.source)}` : ''}`;
  const blocks = (list: readonly LibraryBlockView[]): string =>
    list.length > 0
      ? list
          .map(
            (entry) =>
              `<button class="lib-gnode" data-action="lib-open" data-block="${esc(entry.name)}">${esc(entry.name)}</button>`,
          )
          .join('')
      : `<small class="mu">${esc(x.none)}</small>`;
  // Observée : la trace de la dernière exécution réelle qui a rejoué le bloc (jamais un exemple).
  const activity = insight.activity;
  const events = (activity?.events ?? []).filter((event) => event.key === picked.key);
  const value = (event: (typeof events)[number]): string =>
    event.masked
      ? `<small class="mu">${esc(x.masked)}</small>`
      : event.withheld
        ? `<small class="mu">${esc(x.withheld)}</small>`
        : event.value !== undefined
          ? `<code class="lib-val">${esc(event.value)}</code>`
          : `<small class="mu">${esc(x.noValue)}</small>`;
  const observed = insight.activityLoading
    ? `<p class="mu small" role="status">${esc(x.lastRunLoading)}</p>`
    : !activity?.last
      ? `<p class="mu small">${esc(x.observedNone)}</p>`
      : events.length === 0
        ? `<p class="mu small">${esc(x.observedEmpty(activity.last.run))}</p>`
        : `<p class="mu small">${esc(x.observedIn(activity.last.run, date(state, activity.last.createdAt)))}</p><ol class="plain lib-obs">${events
            .map(
              (event) =>
                `<li><b>${esc(x.events[event.origin] ?? event.origin)}${event.use ? ` · ${esc(x.uses[event.use] ?? event.use)}` : ''}</b><span class="mu small">${event.step !== undefined ? esc(x.scenarioStep(event.step)) : ''}${event.stepName ? ` · ${esc(event.stepName.split(' › ').slice(1).join(' › ') || event.stepName)}` : ''}</span>${value(event)}</li>`,
            )
            .join('')}</ol>`;
  const contractNote =
    picked.detection === 'UNKNOWN' && picked.evidence.length === 0
      ? x.notInContract
      : block.contract.source === 'DECLARED'
        ? x.declaredContract
        : x.derivedContract;
  return `${graph}
<article class="lib-tdetail" aria-labelledby="lib-td-t"><h4 id="lib-td-t"><code class="lib-key">${esc(picked.key)}</code> <small class="mu">${esc(picked.direction === 'input' ? state.t.lib.inputsLabel : state.t.lib.outputsLabel)}</small></h4>
<dl class="lib-dl"><dt>${esc(x.typeLabel)}</dt><dd>${esc(picked.type)} <small class="mu">(${esc(x.typeSource[picked.typeSource] ?? picked.typeSource)})</small> · ${esc(x.version(picked.version))}</dd>${picked.meaning ? `<dt>${esc(x.meaning)}</dt><dd>${esc(picked.meaning)}</dd>` : ''}<dt>${esc(x.originLabel)}</dt><dd>${esc(origin)}</dd><dt>${esc(x.stepsLabel)}</dt><dd><small class="mu">${esc(picked.direction === 'input' ? x.reads : x.produces)}</small>${steps}</dd></dl>
<div class="lib-layers">
<section class="lib-layer"><h5>${esc(x.declared)}</h5><p class="small">${esc(contractNote)}</p></section>
<section class="lib-layer"><h5>${esc(x.detected)} · <span class="lib-det ${picked.detection.toLowerCase()}">${esc(x.detection[picked.detection] ?? picked.detection)}</span></h5>${picked.evidence.length > 0 ? `<ul class="plain tight small">${picked.evidence.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : `<p class="mu small">${esc(x.none)}</p>`}</section>
<section class="lib-layer"><h5>${esc(x.observed)}</h5>${observed}</section>
</div>
<div class="lib-tlinks"><div><h5>${esc(x.producers)}</h5><p>${blocks(producers)}</p></div><div><h5>${esc(x.consumers)}</h5><p>${blocks(consumers)}</p></div><div><h5>${esc(x.scenarios)}</h5><p>${block.usedBy.length > 0 ? block.usedBy.map((name) => `<button class="lnk" data-action="lib-open-scenario" data-name="${esc(name)}">${esc(name)}</button>`).join(' ') : `<small class="mu">${esc(x.none)}</small>`}</p></div></div>
</article>`;
}

// ── Compatibilité avec le parcours ouvert ─────────────────────────────────────────────────────

export interface CompatRow {
  key: string;
  required: boolean;
  status: 'FROM' | 'AMBIGUOUS' | 'DATA' | 'MISSING' | 'OPTIONAL';
  blocks: string[];
}

/**
 * Ce que le parcours ouvert fournit à chaque entrée du bloc, d'après les contrats des blocs qu'il contient :
 * un seul producteur, plusieurs (ambiguë), le jeu de données du bloc, ou rien (manquante). Indicatif : la
 * vérification du parcours (par chemin, avec les conditions et les boucles) reste la référence.
 */
export function journeyCompat(
  state: DashboardState,
  block: LibraryBlockView,
): { rows: CompatRow[]; empty: boolean; pinned?: number } {
  const nodes = state.lib.journey.journey.graph.nodes.filter((node) => node.kind === 'BLOCK' && node.block);
  const blocks = state.lib.blocks ?? [];
  const inJourney = nodes
    .map((node) => blocks.find((entry) => entry.name === node.block))
    .filter((entry): entry is LibraryBlockView => entry !== undefined && entry.name !== block.name);
  const own = new Set(block.data.map((entry) => entry.key));
  const rows = block.contract.inputs.map((input): CompatRow => {
    const from = [
      ...new Set(
        inJourney
          .filter((entry) => entry.contract.outputs.some((output) => output.key === input.key))
          .map((entry) => entry.name),
      ),
    ];
    const status: CompatRow['status'] =
      from.length > 1
        ? 'AMBIGUOUS'
        : from.length === 1
          ? 'FROM'
          : own.has(input.key)
            ? 'DATA'
            : input.required
              ? 'MISSING'
              : 'OPTIONAL';
    return { key: input.key, required: input.required, status, blocks: from };
  });
  const pinnedNode = nodes.find((node) => node.block === block.name && node.version !== undefined);
  return {
    rows,
    empty: nodes.length === 0,
    ...(pinnedNode?.version !== undefined && pinnedNode.version !== block.version
      ? { pinned: pinnedNode.version }
      : {}),
  };
}

export function compatBox(state: DashboardState, block: LibraryBlockView): string {
  if (!can(state, 'PUBLISH')) return '';
  const x = insightText(state);
  const compat = journeyCompat(state, block);
  const text = (row: CompatRow): string =>
    row.status === 'FROM'
      ? x.compatFrom(row.blocks.join(', '))
      : row.status === 'AMBIGUOUS'
        ? x.compatAmbiguous(row.blocks.join(', '))
        : row.status === 'DATA'
          ? x.compatData
          : row.status === 'MISSING'
            ? x.compatMissing
            : x.compatOptional;
  const tone = (row: CompatRow): string =>
    row.status === 'FROM' || row.status === 'DATA' ? 'ok' : row.status === 'MISSING' ? 'ko' : 'warn';
  const rows =
    compat.rows.length === 0
      ? `<p class="mu small">${esc(x.compatNoInputs)}</p>`
      : `<ul class="plain lib-compat">${compat.rows.map((row) => `<li class="${tone(row)}"><code class="lib-key">${esc(row.key)}</code><span>${esc(text(row))}</span></li>`).join('')}</ul>`;
  return `<section class="lib-compat-box" aria-labelledby="lib-compat-t"><h4 id="lib-compat-t">${esc(x.compatTitle)}</h4>${compat.empty && compat.rows.length > 0 ? `<p class="mu small">${esc(x.compatEmpty)}</p>` : ''}${rows}${compat.pinned !== undefined ? `<p class="warn-t small">${esc(x.compatVersion(block.version, compat.pinned))}</p>` : ''}<p class="mu small">${esc(x.compatNote)}</p></section>`;
}

export const INSIGHT_CSS = `
.lib-acts{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.lib-ogrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:10px}
.lib-ocard{border:1px solid var(--qa-color-border);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;min-width:0;background:var(--qa-color-surface)}
.lib-ocard.wide{grid-column:1 / -1}
.lib-fbody .lib-ocard h4,.lib-ocard h4{display:flex;align-items:center;gap:6px;margin:0;font-size:13.5px;text-transform:none;letter-spacing:0;color:var(--qa-color-text)}
.lib-ocard h4 .ico{width:15px;height:15px;color:var(--qa-color-muted)}
.lib-ocard .lib-dl{margin:0}
.lib-col-h{display:flex;align-items:center;justify-content:space-between;gap:8px}
.lib-fields{display:flex;flex-direction:column;gap:6px}
.lib-frow{display:grid;grid-template-columns:22px minmax(0,1fr) auto auto;align-items:center;gap:8px}
.lib-ftype{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;background:color-mix(in srgb,#5B4BCF 12%,transparent);color:#4338CA;font-weight:700;font-size:12px}
.lib-ftype .ico{width:13px;height:13px}
.lib-fname{display:flex;flex-direction:column;min-width:0}
.lib-fname small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lib-req{color:var(--qa-color-danger);font-weight:700}
.lib-tgraph{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:8px;margin:0}
.lib-tcol{display:flex;flex-direction:column;gap:6px;min-width:0}
.lib-tarrow{color:var(--qa-color-muted)}
.lib-tnode{display:flex;flex-direction:column;align-items:center;gap:1px;padding:6px 8px;border-radius:8px;border:1px solid var(--qa-color-border);background:var(--qa-color-surface);font:inherit;font-size:12px;cursor:pointer;min-width:0;overflow-wrap:anywhere;color:var(--qa-color-text)}
.lib-tnode small{font-size:10.5px;color:var(--qa-color-muted)}
.lib-tnode.input{background:color-mix(in srgb,#5B4BCF 8%,transparent);border-color:color-mix(in srgb,#5B4BCF 35%,transparent)}
.lib-tnode.output{background:var(--qa-color-primary-soft);border-color:color-mix(in srgb,var(--qa-color-primary) 45%,transparent)}
.lib-tnode.self{flex-direction:row;gap:6px;cursor:default;font-weight:600;border-color:#5B4BCF}
.lib-tnode.self small{margin-left:4px}
.lib-tnode[aria-pressed="true"]{outline:2px solid var(--qa-color-primary);outline-offset:1px}
.lib-tdetail{display:flex;flex-direction:column;gap:8px;margin-top:10px;padding:10px 12px;border:1px solid var(--qa-color-border);border-radius:10px}
.lib-fbody .lib-tdetail h4{margin:0;text-transform:none;letter-spacing:0;font-size:14px;color:var(--qa-color-text)}
.lib-frow .lib-key{border:0;background:none;padding:0}
.lib-fiche.docked .lib-ftabs{flex-wrap:wrap;overflow:visible}
.lib-layers{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:8px}
.lib-layer{border-radius:8px;padding:8px 10px;background:color-mix(in srgb,var(--qa-color-border) 22%,transparent);min-width:0}
.lib-layer h5,.lib-tlinks h5{margin:0 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--qa-color-muted)}
.lib-det.confirmed{color:var(--qa-color-primary-2)}
.lib-det.probable{color:#92400E}
.lib-obs{display:flex;flex-direction:column;gap:4px}
.lib-obs li{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:baseline;font-size:12.5px}
.lib-val{font-size:12px;word-break:break-all}
.lib-tlinks{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,160px),1fr));gap:8px}
.lib-tlinks p{display:flex;flex-wrap:wrap;gap:4px}
.lib-compat-box,.lib-prev,.lib-dup{border:1px solid var(--qa-color-border);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}
.lib-compat-box h4,.lib-prev h3{margin:0;font-size:13.5px}
.lib-compat{display:flex;flex-direction:column;gap:4px;font-size:12.5px}
.lib-compat li{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline;padding-left:8px;border-left:3px solid var(--qa-color-border)}
.lib-compat li.ok{border-left-color:var(--qa-color-primary)}
.lib-compat li.warn{border-left-color:#D97706}
.lib-compat li.ko{border-left-color:var(--qa-color-danger)}
.lib-prev-steps{display:flex;flex-direction:column;gap:6px;font-size:12.5px}
.lib-fiche-h{display:flex;align-items:flex-start;gap:10px}
.lib-fiche-h .lib-cube .ico{width:26px;height:26px}
.lib-fiche-h h2{margin:0;font-size:19px}
.lib-fiche-h .lib-fiche-sub{margin:2px 0 0;font-size:12.5px;color:var(--qa-color-muted)}
.lib-fiche-h .lib-sheet-x{margin-left:auto}
.lib-ftabs [role="tab"] .lib-tc{margin-left:4px;color:var(--qa-color-muted);font-weight:400}
`;
