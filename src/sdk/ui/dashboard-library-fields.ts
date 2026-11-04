import { DATA_TYPES, type ContractField, type LibraryBlockView } from '../core/contracts.js';
import type { BlockSheet } from './dashboard-library-sheet.js';
import type { DashboardState } from './dashboard-view.js';
import { esc } from './view.js';

/**
 * LES DONNÉES D'UN BLOC DANS SA FICHE (onglets Entrées, Sorties, et le haut de l'onglet Paramètres) : ce que
 * le serveur a établi pour chaque donnée (provenance, étapes, type déclaré / proposé / par défaut, version,
 * statut de détection et sa justification). Une personne peut confirmer une détection, corriger la
 * description d'une donnée, retirer une sortie ; un changement incompatible d'un bloc utilisé n'est
 * enregistré qu'après une validation explicite. Rien n'est décidé ici : le serveur vérifie tout.
 */

/** Une donnée en cours de correction dans la fiche. */
export interface FieldEdit {
  direction: 'input' | 'output';
  key: string;
  label: string;
  description: string;
  meaning: string;
  type: string;
  defaultValue: string;
  busy?: boolean;
  error?: string;
  details?: string[];
  /** Le serveur a refusé un changement incompatible : il peut être validé explicitement. */
  needsAccept?: boolean;
  /** Une confirmation ou un retrait en attente de validation (renvoyé tel quel). */
  confirmed?: boolean;
}

const FR = {
  inputsTitle: 'Données nécessaires au bloc',
  outputsTitle: 'Données produites par le bloc',
  noInputs: 'Ce bloc ne lit aucune donnée.',
  noOutputs: 'Ce bloc n’expose aucune donnée.',
  candidatesTitle: 'Valeurs fixes saisies : des entrées possibles',
  candidatesNote:
    'Une valeur fixe saisie dans un champ pourrait devenir une entrée. La lier à une donnée se fait dans la revue de l’enregistrement (source de la valeur) ou dans l’éditeur : rien n’est transformé ici.',
  key: 'Donnée',
  type: 'Type',
  meaning: 'Sens métier',
  required: 'Obligatoire',
  defaultValue: 'Défaut',
  origin: 'Provenance',
  steps: 'Étapes',
  version: 'Version',
  detection: 'Détection',
  why: 'Pourquoi',
  actions: 'Actions',
  yes: 'Oui',
  no: 'Non',
  none: '—',
  origins: {
    INPUT: 'Fournie en entrée',
    GENERATED: 'Générée au rejeu',
    CAPTURED: 'Capturée',
    DATA: 'Valeur du jeu',
    LITERAL: 'Valeur fixe saisie',
  } as Record<string, string>,
  detections: { CONFIRMED: 'Confirmée', PROBABLE: 'Probable', UNKNOWN: 'Inconnue' } as Record<string, string>,
  typeSources: { DECLARED: 'déclaré', INFERRED: 'proposé', DEFAULT: 'par défaut' } as Record<string, string>,
  types: {
    text: 'Texte',
    number: 'Nombre',
    date: 'Date',
    email: 'E-mail',
    identifier: 'Identifiant',
    boolean: 'Booléen',
    url: 'Adresse (URL)',
  } as Record<string, string>,
  hidden: 'non exposée',
  edit: 'Corriger',
  confirm: 'Confirmer',
  hide: 'Ne plus exposer',
  show: 'Exposer à nouveau',
  label: 'Libellé métier',
  description: 'Description',
  save: 'Enregistrer',
  cancel: 'Annuler',
  accept: 'Valider le changement incompatible',
  incompatibleNote:
    'Ce changement est incompatible et le bloc est utilisé : les scénarios et parcours ci-dessous devront être revus.',
  typeNote:
    'Le moteur saisit et cite du texte : un type déclaré sert à vérifier les correspondances, aucune valeur n’est convertie.',
  saved: (key: string) => `Donnée ${key} enregistrée.`,
  savedIncompatible: (key: string, version: number) =>
    `Donnée ${key} enregistrée : changement incompatible validé, version ${String(version)} de sa définition.`,
  stepRoles: {
    action: 'Action',
    navigation: 'Navigation',
    generation: 'Génération',
    capture: 'Capture',
    wait: 'Attente',
    check: 'Vérification',
    loop: 'Boucle',
  } as Record<string, string>,
  paramsTitle: 'Paramètres configurables',
  paramsNone: 'Aucune entrée à configurer.',
  constraint: 'Contrainte',
  constraintType: (type: string) => `type ${type}`,
  constraintRequired: 'obligatoire',
  generatorsTitle: 'Générateurs et valeurs du jeu',
};
type Text = typeof FR;

const EN: Text = {
  inputsTitle: 'Data the block needs',
  outputsTitle: 'Data the block produces',
  noInputs: 'This block reads no data.',
  noOutputs: 'This block exposes no data.',
  candidatesTitle: 'Fixed values typed: possible inputs',
  candidatesNote:
    'A fixed value typed into a field could become an input. Binding it to a data item is done in the recording review (value source) or in the editor: nothing is transformed here.',
  key: 'Data',
  type: 'Type',
  meaning: 'Business meaning',
  required: 'Required',
  defaultValue: 'Default',
  origin: 'Provenance',
  steps: 'Steps',
  version: 'Version',
  detection: 'Detection',
  why: 'Why',
  actions: 'Actions',
  yes: 'Yes',
  no: 'No',
  none: '—',
  origins: {
    INPUT: 'Provided as input',
    GENERATED: 'Generated at replay',
    CAPTURED: 'Captured',
    DATA: 'Data set value',
    LITERAL: 'Fixed value typed',
  },
  detections: { CONFIRMED: 'Confirmed', PROBABLE: 'Probable', UNKNOWN: 'Unknown' },
  typeSources: { DECLARED: 'declared', INFERRED: 'proposed', DEFAULT: 'default' },
  types: {
    text: 'Text',
    number: 'Number',
    date: 'Date',
    email: 'E-mail',
    identifier: 'Identifier',
    boolean: 'Boolean',
    url: 'Address (URL)',
  },
  hidden: 'not exposed',
  edit: 'Correct',
  confirm: 'Confirm',
  hide: 'Stop exposing',
  show: 'Expose again',
  label: 'Business label',
  description: 'Description',
  save: 'Save',
  cancel: 'Cancel',
  accept: 'Validate the incompatible change',
  incompatibleNote:
    'This change is incompatible and the block is used: the scenarios and journeys below will need a review.',
  typeNote: 'The engine types and cites text: a declared type checks mappings, no value is ever converted.',
  saved: (key) => `Data ${key} saved.`,
  savedIncompatible: (key, version) =>
    `Data ${key} saved: incompatible change validated, version ${String(version)} of its definition.`,
  stepRoles: {
    action: 'Action',
    navigation: 'Navigation',
    generation: 'Generation',
    capture: 'Capture',
    wait: 'Wait',
    check: 'Check',
    loop: 'Loop',
  },
  paramsTitle: 'Configurable parameters',
  paramsNone: 'No input to configure.',
  constraint: 'Constraint',
  constraintType: (type) => `type ${type}`,
  constraintRequired: 'required',
  generatorsTitle: 'Generators and data set values',
};

export const fieldsText = (state: DashboardState): Text => (state.t.locale === 'en' ? EN : FR);

/** Le rôle d'une étape (onglet Étapes). */
export function stepRoleChip(state: DashboardState, role: string | undefined): string {
  if (!role) return '';
  const t = fieldsText(state);
  return `<span class="lib-role ${esc(role)}">${esc(t.stepRoles[role] ?? role)}</span>`;
}

function detectionChip(t: Text, field: ContractField): string {
  const tone = field.detection === 'CONFIRMED' ? 'ok' : field.detection === 'PROBABLE' ? 'warn' : 'ko';
  return `<span class="jn-chip ${tone}">${esc(t.detections[field.detection] ?? field.detection)}</span>`;
}

function editForm(state: DashboardState, edit: FieldEdit): string {
  const t = fieldsText(state);
  const field = (key: keyof FieldEdit, label: string, max: number): string =>
    `<label class="field"><span>${esc(label)}</span><input data-lib="field.${key}" value="${esc(String(edit[key] ?? ''))}" maxlength="${String(max)}" autocomplete="off"></label>`;
  return `<div class="lib-fedit" role="group" aria-label="${esc(`${t.edit} ${edit.key}`)}"><h4><code>${esc(edit.key)}</code></h4>${field('label', t.label, 80)}${field('description', t.description, 300)}${field('meaning', t.meaning, 120)}<label class="field"><span>${esc(t.type)}</span><select data-lib="field.type"><option value="">${esc(t.none)}</option>${DATA_TYPES.map((type) => `<option value="${type}"${edit.type === type ? ' selected' : ''}>${esc(t.types[type] ?? type)}</option>`).join('')}</select></label><p class="mu small">${esc(t.typeNote)}</p>${edit.direction === 'input' ? field('defaultValue', t.defaultValue, 300) : ''}${
    edit.error
      ? `<div class="err" role="alert"><p>${esc(edit.error)}</p>${edit.details && edit.details.length > 0 ? `<ul class="plain tight">${edit.details.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}${edit.needsAccept ? `<p class="small">${esc(t.incompatibleNote)}</p>` : ''}</div>`
      : ''
  }<div class="form-acts start"><button type="button" class="btn small primary" data-action="lib-field-save"${edit.busy ? ' disabled' : ''}>${esc(t.save)}</button>${edit.needsAccept ? `<button type="button" class="btn small danger" data-action="lib-field-accept"${edit.busy ? ' disabled' : ''}>${esc(t.accept)}</button>` : ''}<button type="button" class="btn small ghost" data-action="lib-field-cancel">${esc(t.cancel)}</button></div></div>`;
}

function fieldTable(
  state: DashboardState,
  fields: readonly ContractField[],
  sheet: BlockSheet,
  publish: boolean,
  direction: 'input' | 'output',
): string {
  const t = fieldsText(state);
  const head =
    direction === 'input'
      ? [t.key, t.type, t.meaning, t.required, t.defaultValue, t.origin, t.version, t.detection, t.why]
      : [t.key, t.type, t.meaning, t.origin, t.steps, t.version, t.detection, t.why];
  const rows = fields
    .map((field) => {
      const attrs = `data-dir="${direction}" data-key="${esc(field.key)}"`;
      const actions = publish
        ? `<td class="lib-facts">${field.detection !== 'CONFIRMED' ? `<button type="button" class="btn small" data-action="lib-field-confirm" ${attrs}>${esc(t.confirm)}</button>` : ''}<button type="button" class="btn small ghost" data-action="lib-field-edit" ${attrs}>${esc(t.edit)}</button>${direction === 'output' ? `<button type="button" class="btn small ghost" data-action="lib-field-expose" ${attrs} data-value="${field.exposed ? '0' : '1'}">${esc(field.exposed ? t.hide : t.show)}</button>` : ''}</td>`
        : '';
      const name = `<code class="lib-key${field.exposed ? '' : ' off'}">${esc(field.key)}</code>${field.label ? `<small class="block">${esc(field.label)}</small>` : ''}${field.exposed ? '' : ` <small class="mu">(${esc(t.hidden)})</small>`}`;
      const type = `${esc(t.types[field.type] ?? field.type)} <small class="mu">(${esc(t.typeSources[field.typeSource] ?? field.typeSource)})</small>`;
      const origin = `${esc(t.origins[field.origin] ?? field.origin)}${field.generator ? ` <small class="mu">· ${esc(field.generator)}</small>` : ''}${field.capture ? `<small class="block mu">${esc(field.capture.source)}</small>` : ''}`;
      const why = `<details class="lib-why"><summary>${esc(t.why)}</summary><ul class="plain tight">${field.evidence.map((item) => `<li>${esc(item)}</li>`).join('')}</ul></details>`;
      const cells =
        direction === 'input'
          ? [
              name,
              type,
              esc(field.meaning ?? t.none),
              esc(field.required ? t.yes : t.no),
              field.defaultValue ? `<code>${esc(field.defaultValue)}</code>` : esc(t.none),
              `${origin}${field.steps.length > 0 ? `<small class="block mu">${esc(t.steps)} ${field.steps.join(', ')}</small>` : ''}`,
              `v${String(field.version)}`,
              detectionChip(t, field),
              why,
            ]
          : [
              name,
              type,
              esc(field.meaning ?? t.none),
              origin,
              esc(field.steps.join(', ') || t.none),
              `v${String(field.version)}`,
              detectionChip(t, field),
              why,
            ];
      const editing =
        sheet.field && sheet.field.direction === direction && sheet.field.key === field.key
          ? `<tr class="lib-fedit-row"><td colspan="${String(head.length + (publish ? 1 : 0))}">${editForm(state, sheet.field)}</td></tr>`
          : '';
      return `<tr data-field="${esc(`${direction}:${field.key}`)}">${cells.map((cell) => `<td>${cell}</td>`).join('')}${actions}</tr>${editing}`;
    })
    .join('');
  return `<div class="jn-tbl-w"><table class="tbl lib-fields"><thead><tr>${head.map((title) => `<th scope="col">${esc(title)}</th>`).join('')}${publish ? `<th scope="col"><span class="sr">${esc(t.actions)}</span></th>` : ''}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

/** Onglet Entrées : les données lues, puis les valeurs fixes qui pourraient en devenir. */
export function inputsTab(
  state: DashboardState,
  block: LibraryBlockView,
  sheet: BlockSheet,
  publish: boolean,
): string {
  const t = fieldsText(state);
  const fields = block.contract.fields;
  const inputs = fields?.inputs ?? [];
  const candidates = fields?.candidates ?? [];
  return `<h4>${esc(t.inputsTitle)}</h4>${inputs.length === 0 ? `<p class="mu">${esc(t.noInputs)}</p>` : fieldTable(state, inputs, sheet, publish, 'input')}${
    candidates.length > 0
      ? `<h4>${esc(t.candidatesTitle)}</h4><ul class="plain lib-cands">${candidates
          .map(
            (field) =>
              `<li>${detectionChip(t, field)} <code class="lib-key">${esc(field.key)}</code> <small class="mu">${esc(field.evidence.join(' · '))}</small></li>`,
          )
          .join('')}</ul><p class="mu small">${esc(t.candidatesNote)}</p>`
      : ''
  }`;
}

/** Onglet Sorties : générées, capturées, valeurs du jeu ; exposées ou retirées. */
export function outputsTab(
  state: DashboardState,
  block: LibraryBlockView,
  sheet: BlockSheet,
  publish: boolean,
): string {
  const t = fieldsText(state);
  const outputs = block.contract.fields?.outputs ?? [];
  return `<h4>${esc(t.outputsTitle)}</h4>${outputs.length === 0 ? `<p class="mu">${esc(t.noOutputs)}</p>` : fieldTable(state, outputs, sheet, publish, 'output')}`;
}

/** Le haut de l'onglet Paramètres : les entrées configurables, leur défaut et leurs contraintes. */
export function paramsSection(state: DashboardState, block: LibraryBlockView): string {
  const t = fieldsText(state);
  const inputs = block.contract.fields?.inputs ?? [];
  const body =
    inputs.length === 0
      ? `<p class="mu">${esc(t.paramsNone)}</p>`
      : `<table class="tbl lib-data"><thead><tr><th scope="col">${esc(t.key)}</th><th scope="col">${esc(t.defaultValue)}</th><th scope="col">${esc(t.constraint)}</th></tr></thead><tbody>${inputs
          .map(
            (field) =>
              `<tr><td><code>${esc(field.key)}</code>${field.label ? ` <small class="mu">${esc(field.label)}</small>` : ''}</td><td>${field.defaultValue ? `<code>${esc(field.defaultValue)}</code>` : esc(t.none)}</td><td>${esc([field.required ? t.constraintRequired : '', field.typeSource === 'DEFAULT' ? '' : t.constraintType(t.types[field.type] ?? field.type)].filter(Boolean).join(', ') || t.none)}</td></tr>`,
          )
          .join('')}</tbody></table>`;
  return `<h4>${esc(t.paramsTitle)}</h4>${body}<h4>${esc(t.generatorsTitle)}</h4>`;
}

export const FIELDS_CSS = `
.lib-fields td{vertical-align:top}
.lib-fields .lib-key.off{opacity:.6;text-decoration:line-through}
.lib-facts{display:flex;flex-wrap:wrap;gap:4px}
.lib-why summary{cursor:pointer;font-size:12px;color:var(--qa-color-muted)}
.lib-why ul{margin-top:4px;font-size:12px;max-width:320px}
.lib-fedit{display:flex;flex-direction:column;gap:8px;padding:8px;border:1px solid var(--qa-color-border);border-radius:8px;background:var(--qa-color-surface-2)}
.lib-fedit .field input,.lib-fedit .field select{width:100%;box-sizing:border-box}
.lib-fedit h4{margin:0}
.lib-cands{display:flex;flex-direction:column;gap:4px}
.lib-role{display:inline-block;margin-left:6px;padding:0 6px;border-radius:999px;font-size:11px;border:1px solid var(--qa-color-border);color:var(--qa-color-muted)}
.lib-role.generation{color:var(--qa-color-primary-2);background:var(--qa-color-primary-soft)}
.lib-role.capture{color:var(--qa-color-data,#2F7DE1);border-color:currentColor}
.lib-role.wait{color:var(--qa-color-warning);background:var(--qa-color-warning-soft)}
.lib-role.loop{color:#7C3AED;border-color:currentColor;background:color-mix(in srgb,#7C3AED 10%,transparent)}
`;
