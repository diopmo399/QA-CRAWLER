import {
  DATA_TYPES,
  OUTPUT_GENERATORS,
  OUTPUT_SOURCES,
  OUTPUT_TRANSFORMS,
  type BlockOutputInput,
  type LibraryBlockDetails,
  type LibraryBlockView,
  type OutputSource,
} from '../core/contracts.js';
import { icon } from './dashboard-parts.js';
import type { DashboardState } from './dashboard-view.js';
import { esc } from './view.js';

/**
 * « AJOUTER UNE SORTIE » dans la fiche d'un bloc (onglet Sorties) : la sortie est produite par une étape
 * exécutable insérée dans le bloc (voir OUTPUT_SOURCES) ; rien n'est une simple déclaration. Le bloc passe
 * à « modifié » : sa nouvelle version est à valider explicitement avant que les parcours l'utilisent.
 */

/** Le formulaire en cours (chaque champ tel que saisi ; le serveur vérifie tout). */
export interface OutputForm {
  key: string;
  label: string;
  meaning: string;
  type: string;
  source: OutputSource;
  after: number;
  generator: string;
  selector: string;
  attribute: string;
  pattern: string;
  param: string;
  method: string;
  url: string;
  field: string;
  from: string;
  transform: string;
  busy?: boolean;
  error?: string;
}

export const newOutputForm = (steps: number): OutputForm => ({
  key: '',
  label: '',
  meaning: '',
  type: '',
  source: 'GENERATED',
  after: steps,
  generator: 'company',
  selector: '',
  attribute: '',
  pattern: '',
  param: '',
  method: '',
  url: '',
  field: '',
  from: '',
  transform: '',
});

const FR = {
  open: 'Ajouter une sortie',
  title: 'Ajouter une sortie',
  intro:
    'Une sortie est produite par une étape exécutable insérée dans le bloc. Le bloc passe à « modifié » : validez sa nouvelle version avant de l’utiliser.',
  key: 'Clé technique',
  keyHint: 'company.id',
  label: 'Libellé métier',
  meaning: 'Sens métier',
  type: 'Type',
  typeAuto: 'Proposé d’après la source',
  source: 'Source',
  sources: {
    GENERATED: 'Variable générée',
    DOM_TEXT: 'Texte d’un élément de l’écran',
    DOM_ATTRIBUTE: 'Attribut d’un élément de l’écran',
    URL: 'Adresse courante',
    RESPONSE: 'Réponse HTTP observée',
    INPUT: 'Entrée du bloc transmise',
  } as Record<string, string>,
  after: 'Produite après l’étape',
  start: 'Avant la première étape',
  generator: 'Générateur',
  selector: 'Sélecteur CSS de l’élément',
  attribute: 'Attribut',
  pattern: 'Motif (groupe 1 retenu, facultatif)',
  param: 'Paramètre de l’adresse',
  urlPattern: 'ou motif de l’adresse (groupe 1)',
  method: 'Méthode',
  anyMethod: 'Toutes',
  url: 'Adresse de la requête',
  field: 'Champ lu dans la réponse',
  fieldHint: 'items.0.id',
  responseNote: 'Lu dans une réponse à une écriture observée pendant le rejeu (corps masqués).',
  from: 'Entrée ou donnée transmise',
  transform: 'Transformation',
  transforms: {
    '': 'Aucune',
    uppercase: 'Majuscules',
    lowercase: 'Minuscules',
    trim: 'Espaces retirés',
    digits: 'Chiffres seulement',
  } as Record<string, string>,
  submit: 'Ajouter la sortie',
  busy: 'Ajout…',
  cancel: 'Annuler',
  done: (key: string, version: number) =>
    `Sortie ${key} ajoutée par une étape du bloc : validez la version ${String(version)} pour l’utiliser.`,
};
type Text = typeof FR;
const EN: Text = {
  open: 'Add an output',
  title: 'Add an output',
  intro:
    'An output is produced by an executable step inserted in the block. The block becomes “changed”: validate its new version before using it.',
  key: 'Technical key',
  keyHint: 'company.id',
  label: 'Business label',
  meaning: 'Business meaning',
  type: 'Type',
  typeAuto: 'Proposed from the source',
  source: 'Source',
  sources: {
    GENERATED: 'Generated variable',
    DOM_TEXT: 'Text of a screen element',
    DOM_ATTRIBUTE: 'Attribute of a screen element',
    URL: 'Current address',
    RESPONSE: 'Observed HTTP response',
    INPUT: 'Block input passed through',
  },
  after: 'Produced after step',
  start: 'Before the first step',
  generator: 'Generator',
  selector: 'CSS selector of the element',
  attribute: 'Attribute',
  pattern: 'Pattern (group 1 kept, optional)',
  param: 'Address parameter',
  urlPattern: 'or address pattern (group 1)',
  method: 'Method',
  anyMethod: 'Any',
  url: 'Request address',
  field: 'Field read in the response',
  fieldHint: 'items.0.id',
  responseNote: 'Read in a response to a write observed during the replay (bodies masked).',
  from: 'Input or data passed through',
  transform: 'Transformation',
  transforms: {
    '': 'None',
    uppercase: 'Uppercase',
    lowercase: 'Lowercase',
    trim: 'Spaces trimmed',
    digits: 'Digits only',
  },
  submit: 'Add the output',
  busy: 'Adding…',
  cancel: 'Cancel',
  done: (key, version) =>
    `Output ${key} added by a step of the block: validate version ${String(version)} to use it.`,
};
export const outputText = (state: DashboardState): Text => (state.t.locale === 'en' ? EN : FR);

/** Le formulaire (ou le bouton qui l'ouvre). */
export function outputFormHtml(
  state: DashboardState,
  block: LibraryBlockView,
  details: LibraryBlockDetails | undefined,
  form: OutputForm | undefined,
  publish: boolean,
): string {
  if (!publish) return '';
  const t = outputText(state);
  if (!form)
    return `<div class="form-acts start"><button type="button" class="btn small" data-action="lib-output-open">${icon('plus')}<span>${esc(t.open)}</span></button></div>`;
  const text = (key: keyof OutputForm, label: string, hint = '', mono = false): string =>
    `<label class="field"><span>${esc(label)}</span><input data-lib="output.${key}" value="${esc(String(form[key] ?? ''))}" placeholder="${esc(hint)}" maxlength="300" autocomplete="off" spellcheck="false"${mono ? ' class="mono"' : ''}></label>`;
  const select = (key: keyof OutputForm, label: string, options: [string, string][]): string =>
    `<label class="field"><span>${esc(label)}</span><select data-lib="output.${key}">${options.map(([value, name]) => `<option value="${esc(value)}"${String(form[key]) === value ? ' selected' : ''}>${esc(name)}</option>`).join('')}</select></label>`;
  const steps = details?.steps ?? [];
  const inputs = [
    ...block.contract.inputs.map((input) => input.key),
    ...block.data.map((entry) => entry.key),
  ];
  let source = '';
  switch (form.source) {
    case 'GENERATED':
      source = select(
        'generator',
        t.generator,
        OUTPUT_GENERATORS.map((generator) => [generator, generator]),
      );
      break;
    case 'DOM_TEXT':
      source = `${text('selector', t.selector, '#company-id', true)}${text('pattern', t.pattern, '', true)}`;
      break;
    case 'DOM_ATTRIBUTE':
      source = `${text('selector', t.selector, 'a.detail', true)}${text('attribute', t.attribute, 'href', true)}${text('pattern', t.pattern, '', true)}`;
      break;
    case 'URL':
      source = `${text('param', t.param, 'id', true)}${text('pattern', t.urlPattern, '/companies/(\\d+)', true)}`;
      break;
    case 'RESPONSE':
      source = `<div class="jn-row2">${select('method', t.method, [
        ['', t.anyMethod],
        ['POST', 'POST'],
        ['PUT', 'PUT'],
        ['PATCH', 'PATCH'],
        ['DELETE', 'DELETE'],
      ])}${text('url', t.url, '/api/companies', true)}</div>${text('field', t.field, t.fieldHint, true)}<p class="mu small">${esc(t.responseNote)}</p>`;
      break;
    case 'INPUT':
      source = select('from', t.from, [
        ['', '—'],
        ...[...new Set(inputs)].map((key): [string, string] => [key, key]),
      ]);
      break;
  }
  return `<section class="lib-out" role="group" aria-labelledby="lib-out-t"><h4 id="lib-out-t">${icon('plus')}<span>${esc(t.title)}</span></h4><p class="mu small">${esc(t.intro)}</p><div class="jn-row2">${text('key', t.key, t.keyHint, true)}${text('label', t.label)}</div>${text('meaning', t.meaning)}<div class="jn-row2">${select(
    'source',
    t.source,
    OUTPUT_SOURCES.map((value) => [value, t.sources[value] ?? value]),
  )}${select('type', t.type, [
    ['', t.typeAuto],
    ...DATA_TYPES.map((type): [string, string] => [type, type]),
  ])}</div>${source}<div class="jn-row2">${select('after', t.after, [
    ['0', t.start],
    ...steps.map((step): [string, string] => [
      String(step.position),
      `${String(step.position)} · ${step.label.slice(0, 60)}`,
    ]),
  ])}${select(
    'transform',
    t.transform,
    ['', ...OUTPUT_TRANSFORMS].map((value): [string, string] => [value, t.transforms[value] ?? value]),
  )}</div>${form.error ? `<p class="err" role="alert">${esc(form.error)}</p>` : ''}<div class="form-acts start"><button type="button" class="btn small primary" data-action="lib-output-add"${form.busy ? ' disabled' : ''} aria-busy="${String(Boolean(form.busy))}">${esc(form.busy ? t.busy : t.submit)}</button><button type="button" class="btn small ghost" data-action="lib-output-cancel">${esc(t.cancel)}</button></div></section>`;
}

/** La demande envoyée au serveur (seulement les champs utiles à la source choisie). */
export function outputRequest(form: OutputForm): BlockOutputInput {
  const type = DATA_TYPES.find((entry) => entry === form.type);
  const transform = OUTPUT_TRANSFORMS.find((entry) => entry === form.transform);
  const keep = (name: keyof OutputForm): Partial<BlockOutputInput> => {
    const value = String(form[name] ?? '').trim();
    return value ? { [name]: value } : {};
  };
  const bySource: Record<OutputSource, (keyof OutputForm)[]> = {
    GENERATED: ['generator'],
    DOM_TEXT: ['selector', 'pattern'],
    DOM_ATTRIBUTE: ['selector', 'attribute', 'pattern'],
    URL: ['param', 'pattern'],
    RESPONSE: ['method', 'url', 'field'],
    INPUT: ['from'],
  };
  return {
    key: form.key.trim(),
    source: form.source,
    after: form.after,
    ...keep('label'),
    ...keep('meaning'),
    ...(type ? { type } : {}),
    ...(transform ? { transform } : {}),
    ...Object.assign({}, ...bySource[form.source].map(keep)),
  } as BlockOutputInput;
}

export const OUTPUT_CSS = `
.lib-out{border:1px solid color-mix(in srgb,var(--qa-color-primary) 40%,var(--qa-color-border));border-radius:10px;padding:10px 12px;margin-top:10px;display:flex;flex-direction:column;gap:6px}
.lib-out h4{display:flex;align-items:center;gap:6px;margin:0;font-size:13px}
`;
