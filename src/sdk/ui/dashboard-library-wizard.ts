import { QaCrawlerError, type QaCrawlerClient } from '../core/client.js';
import type {
  BlockContract,
  DeclaredContract,
  ExtractionInput,
  ExtractionPlan,
  ExtractionStepView,
  GroupViewDto,
  LibrarySourcePreview,
} from '../core/contracts.js';
import { icon } from './dashboard-parts.js';
import type { DashboardState } from './dashboard-view.js';
import { esc } from './view.js';

/**
 * LA FENÊTRE « AJOUTER UN BLOC » : un assistant en quatre étapes (Informations, Entrées / Sorties,
 * Paramètres, Confirmation) qui crée une nouvelle définition dans la bibliothèque, sans quitter la page ni
 * toucher au parcours en cours. Tout vient des API réelles :
 * - origine « scénario » : `library.preview` (étapes, données, contrat déduit), `library.check` (les
 *   vérifications de la création, sans rien écrire), puis `library.add` (avec un contrat déclaré, s’il l’est) ;
 * - origine « enregistrement » : un groupe d'étapes (et les étapes retenues), `library.planExtraction`
 *   (plan et validation, sans rien écrire), puis `library.publishExtraction` et, si le contrat est déclaré,
 *   `library.declareContract`.
 * Le type de bloc n'est pas un choix : une condition ou une jonction est un élément du diagramme, pas un bloc.
 * La catégorie et la version initiale (v1) suivent les règles existantes : elles ne s'inventent pas.
 */

export type WizardStep = 1 | 2 | 3 | 4;

export interface WizardUi {
  step: WizardStep;
  origin: 'scenario' | 'recording';
  scenario: string;
  recording: string;
  groupId: string;
  /** Les étapes retenues du groupe (absent : toutes). */
  stepIds?: string[];
  name: string;
  description: string;
  preview?: LibrarySourcePreview;
  previewFor?: string;
  recordings?: string[];
  groups?: GroupViewDto[];
  groupsFor?: string;
  plan?: ExtractionPlan;
  planFor?: string;
  /** Les étapes du groupe entier (pour en retenir une partie). */
  groupSteps?: ExtractionStepView[];
  /** Le contrat déclaré explicitement (sinon déduit des étapes). */
  declare: boolean;
  optional: string[];
  outputs?: string[];
  check?: { ok: boolean; errors: string[]; warnings: string[] };
  checkFor?: string;
  loading?: boolean;
  checking?: boolean;
  busy?: boolean;
  error?: string;
  dirty: boolean;
  confirmClose?: boolean;
}

const NAME_MAX = 80;

const FR = {
  title: 'Ajouter un bloc',
  subtitle: 'Créer un nouveau bloc réutilisable dans la bibliothèque.',
  close: 'Fermer',
  steps: ['Informations', 'Entrées / Sorties', 'Paramètres', 'Confirmation'],
  stepLabel: (n: number, label: string, state: string) => `Étape ${String(n)} : ${label} (${state})`,
  stateDone: 'terminée',
  stateCurrent: 'en cours',
  stateTodo: 'à venir',
  infoTitle: 'Informations du bloc',
  name: 'Nom du bloc',
  namePlaceholder: 'Ex. : Créer un dossier',
  description: 'Description',
  descriptionPlaceholder: 'Décrivez le rôle du bloc, son objectif et son utilisation…',
  category: 'Catégorie',
  categoryOf: (origin: string) => `Déduite de l’origine : ${origin}`,
  version: 'Version initiale',
  versionNote: 'Un nouveau bloc commence en v1 ; chaque changement validé crée la version suivante.',
  type: 'Type de bloc',
  typeStandard: 'Bloc standard',
  typeStandardHint: 'Exécute un ensemble d’étapes',
  typeNote:
    'Les conditions et les jonctions sont des éléments du diagramme, pas des blocs : elles se posent dans le compositeur.',
  origin: 'Origine',
  originScenario: 'Un scénario existant',
  originRecording: 'Un groupe d’étapes d’un enregistrement',
  scenario: 'Scénario source',
  noScenario: 'Aucun scénario YAML à reprendre dans ce projet.',
  recording: 'Enregistrement',
  noRecording: 'Aucun enregistrement dans ce projet.',
  group: 'Groupe d’étapes',
  noGroup: 'Cet enregistrement n’a pas de groupe d’étapes : regroupez-en dans sa revue.',
  stepsPick: 'Étapes retenues',
  allSteps: 'Toutes',
  loading: 'Lecture de la source…',
  sourceSteps: (n: number, start?: string) =>
    `${String(n)} étape(s) exécutable(s)${start ? ` · départ ${start}` : ''}`,
  noSteps: 'Cette source n’a aucune étape exécutable : le moteur ne peut pas en faire un bloc.',
  nameRequired: 'Le nom est obligatoire.',
  nameTooLong: `Le nom fait au plus ${String(NAME_MAX)} caractères.`,
  nameTaken: (name: string) => `« ${name} » est déjà pris par un scénario ou un bloc.`,
  ioTitle: 'Entrées et sorties',
  inputs: 'Entrées nécessaires',
  outputs: 'Sorties produites',
  key: 'Donnée',
  kind: 'Type',
  required: 'Obligation',
  requiredYes: 'obligatoire',
  requiredNo: 'facultative',
  kindInput: 'fournie avant le bloc',
  kindDynamic: 'générée au rejeu',
  kindFixed: 'valeur du bloc',
  noInputs: 'Aucune entrée : le bloc se joue sans donnée fournie avant lui.',
  noOutputs: 'Aucune sortie : le bloc ne saisit aucune donnée de son propre jeu.',
  derived: 'Contrat déduit des étapes',
  declared: 'Contrat déclaré explicitement',
  declareToggle: 'Déclarer le contrat explicitement (choisir les sorties, les entrées facultatives)',
  keepOutput: (key: string) => `Déclarer la sortie ${key}`,
  missing: 'Données consommées que rien ne produit',
  dependencies: 'Dépendances',
  paramsTitle: 'Paramètres configurables',
  paramsIntro:
    'Les paramètres d’un bloc sont ses entrées : chaque instance d’un parcours leur donne une valeur, une correspondance vers une autre donnée, ou les reçoit de l’amont. Leur valeur se renseigne dans le compositeur, jamais ici.',
  param: 'Paramètre',
  default: 'Valeur par défaut',
  defaultNone: 'aucune : fournie par le parcours',
  mapping: 'Correspondance',
  mappingNone: 'même nom en amont',
  optionalToggle: (key: string) => `${key} facultative`,
  noParams: 'Ce bloc n’attend aucune donnée : aucun paramètre à configurer.',
  confirmTitle: 'Récapitulatif',
  originLabel: 'Origine',
  stepsCount: 'Étapes',
  checksTitle: 'Vérifications',
  checking: 'Vérification en cours…',
  checkOk: 'Le bloc peut être créé.',
  checkKo: 'Création impossible tant que ces erreurs restent.',
  errors: 'Erreurs bloquantes',
  needsInputs: (n: number) =>
    `Le bloc attend ${String(n)} entrée(s) : un parcours devra les fournir avant lui (amont, valeur ou correspondance).`,
  warnings: 'Avertissements',
  fixAt: (step: string) => `Revenir à « ${step} »`,
  cancel: 'Annuler',
  previous: 'Précédent',
  next: 'Suivant',
  create: 'Créer le bloc',
  creating: 'Création…',
  discardTitle: 'Abandonner la création du bloc ?',
  discardText: 'Les informations saisies seront perdues.',
  discardYes: 'Abandonner',
  discardNo: 'Continuer',
  created: (name: string) => `Bloc créé avec succès : « ${name} ».`,
  helpTitle: 'Nouveau bloc',
  help: [
    [
      'Réutilisable dans plusieurs parcours',
      'Entrées et sorties déduites de ses étapes',
      'Paramètres d’instance : ses entrées',
      'Versionné (v1) et traçable : son origine est gardée',
    ],
    [
      'Une entrée est une donnée que le bloc utilise sans la définir',
      'Une sortie est une donnée que le bloc saisit depuis son propre jeu',
      'Le contrat déduit suit les étapes ; un contrat déclaré doit leur correspondre',
    ],
    [
      'Une valeur saisie dans un parcours ne modifie jamais le bloc',
      'Deux instances d’un même bloc gardent chacune leur valeur',
      'Une entrée obligatoire non fournie est signalée à la vérification du parcours',
    ],
    [
      'La création refait ces vérifications côté serveur',
      'Le bloc rejoint la bibliothèque en v1',
      'Il n’est pas ajouté au parcours en cours : utilisez « Au parcours » ou glissez-le',
    ],
  ],
} as const;

type Text = {
  [K in keyof typeof FR]: (typeof FR)[K] extends (...args: infer A) => string
    ? (...args: A) => string
    : (typeof FR)[K] extends readonly (readonly string[])[]
      ? readonly (readonly string[])[]
      : (typeof FR)[K] extends readonly string[]
        ? readonly string[]
        : string;
};

const EN: Text = {
  title: 'Add a block',
  subtitle: 'Create a new reusable block in the library.',
  close: 'Close',
  steps: ['Information', 'Inputs / Outputs', 'Parameters', 'Confirmation'],
  stepLabel: (n, label, state) => `Step ${String(n)}: ${label} (${state})`,
  stateDone: 'done',
  stateCurrent: 'current',
  stateTodo: 'to come',
  infoTitle: 'Block information',
  name: 'Block name',
  namePlaceholder: 'E.g. Create a file',
  description: 'Description',
  descriptionPlaceholder: 'Describe the role of the block, its goal and its use…',
  category: 'Category',
  categoryOf: (origin) => `From its origin: ${origin}`,
  version: 'Initial version',
  versionNote: 'A new block starts at v1; each validated change creates the next version.',
  type: 'Block type',
  typeStandard: 'Standard block',
  typeStandardHint: 'Runs a set of steps',
  typeNote: 'Conditions and joins are diagram elements, not blocks: place them in the composer.',
  origin: 'Origin',
  originScenario: 'An existing scenario',
  originRecording: 'A group of steps from a recording',
  scenario: 'Source scenario',
  noScenario: 'No YAML scenario to reuse in this project.',
  recording: 'Recording',
  noRecording: 'No recording in this project.',
  group: 'Group of steps',
  noGroup: 'This recording has no group of steps: group some in its review.',
  stepsPick: 'Steps kept',
  allSteps: 'All',
  loading: 'Reading the source…',
  sourceSteps: (n, start) => `${String(n)} runnable step(s)${start ? ` · starts at ${start}` : ''}`,
  noSteps: 'This source has no runnable step: the engine cannot make a block of it.',
  nameRequired: 'The name is required.',
  nameTooLong: `The name has at most ${String(NAME_MAX)} characters.`,
  nameTaken: (name) => `“${name}” is already taken by a scenario or a block.`,
  ioTitle: 'Inputs and outputs',
  inputs: 'Inputs needed',
  outputs: 'Outputs produced',
  key: 'Data',
  kind: 'Type',
  required: 'Required',
  requiredYes: 'required',
  requiredNo: 'optional',
  kindInput: 'provided before the block',
  kindDynamic: 'generated at replay',
  kindFixed: 'block value',
  noInputs: 'No input: the block plays without data provided before it.',
  noOutputs: 'No output: the block fills no data from its own set.',
  derived: 'Contract derived from the steps',
  declared: 'Contract declared explicitly',
  declareToggle: 'Declare the contract explicitly (choose the outputs, the optional inputs)',
  keepOutput: (key) => `Declare the output ${key}`,
  missing: 'Data consumed that nothing produces',
  dependencies: 'Dependencies',
  paramsTitle: 'Configurable parameters',
  paramsIntro:
    'A block’s parameters are its inputs: each instance in a journey gives them a value, a mapping to other data, or receives them from upstream. Their value is set in the composer, never here.',
  param: 'Parameter',
  default: 'Default value',
  defaultNone: 'none: provided by the journey',
  mapping: 'Mapping',
  mappingNone: 'same name upstream',
  optionalToggle: (key) => `${key} optional`,
  noParams: 'This block expects no data: no parameter to configure.',
  confirmTitle: 'Summary',
  originLabel: 'Origin',
  stepsCount: 'Steps',
  checksTitle: 'Checks',
  checking: 'Checking…',
  checkOk: 'The block can be created.',
  checkKo: 'Creation impossible while these errors remain.',
  errors: 'Blocking errors',
  needsInputs: (n) =>
    `The block expects ${String(n)} input(s): a journey must provide them before it (upstream, value or mapping).`,
  warnings: 'Warnings',
  fixAt: (step) => `Back to “${step}”`,
  cancel: 'Cancel',
  previous: 'Previous',
  next: 'Next',
  create: 'Create the block',
  creating: 'Creating…',
  discardTitle: 'Abandon the creation of the block?',
  discardText: 'The information entered will be lost.',
  discardYes: 'Abandon',
  discardNo: 'Continue',
  created: (name) => `Block created successfully: “${name}”.`,
  helpTitle: 'New block',
  help: [
    [
      'Reusable in several journeys',
      'Inputs and outputs derived from its steps',
      'Instance parameters: its inputs',
      'Versioned (v1) and traceable: its origin is kept',
    ],
    [
      'An input is data the block uses without defining it',
      'An output is data the block fills from its own set',
      'The derived contract follows the steps; a declared one must match them',
    ],
    [
      'A value set in a journey never changes the block',
      'Two instances of one block each keep their value',
      'A required input not provided is reported by the journey check',
    ],
    [
      'Creation redoes these checks on the server',
      'The block joins the library at v1',
      'It is not added to the current journey: use “Add to journey” or drag it',
    ],
  ],
};

export const wizardText = (state: DashboardState): Text => (state.t.locale === 'en' ? EN : FR);

export function emptyWizard(scenario: string): WizardUi {
  return {
    step: 1,
    origin: 'scenario',
    scenario,
    recording: '',
    groupId: '',
    name: '',
    description: '',
    declare: false,
    optional: [],
    dirty: false,
  };
}

/** La clé de la source choisie : un aperçu ou un plan d'une autre source ne vaut plus. */
export const sourceKey = (w: WizardUi): string =>
  w.origin === 'scenario'
    ? `s:${w.scenario}`
    : `r:${w.recording}:${w.groupId}:${(w.stepIds ?? []).join(',')}`;

/** Ce que la source donnera : étapes, départ, données, contrat déduit, dépendances non satisfaites. */
export function sourceOf(w: WizardUi):
  | {
      steps: number;
      startAt?: string;
      data: { key: string; dynamic: boolean }[];
      contract: BlockContract;
      missing: string[];
      dependencies: string[];
      originLabel: string;
    }
  | undefined {
  if (w.origin === 'scenario') {
    const preview = w.preview && w.previewFor === sourceKey(w) ? w.preview : undefined;
    if (!preview) return undefined;
    return {
      steps: preview.steps,
      ...(preview.startAt ? { startAt: preview.startAt } : {}),
      data: preview.data,
      contract: preview.contract,
      missing: [],
      dependencies: [],
      originLabel: preview.scenario,
    };
  }
  const plan = w.plan && w.planFor === sourceKey(w) ? w.plan : undefined;
  const block = plan?.blocks[0];
  if (!plan || !block) return undefined;
  return {
    steps: block.steps.length,
    startAt: block.startAt,
    data: block.data,
    contract: block.contract,
    missing: block.dependencies.filter((entry) => entry.source === 'NOWHERE').map((entry) => entry.key),
    dependencies: block.dependencies.map((entry) => `${entry.key} : ${entry.source}`),
    originLabel: `${plan.recording} · ${block.groups.map((group) => group.name).join(', ')}`,
  };
}

/** Le nom : obligatoire, borné, libre parmi les scénarios et les blocs du projet (même portée que le serveur). */
export function nameProblem(state: DashboardState, w: WizardUi): string | undefined {
  const t = wizardText(state);
  const name = w.name.replace(/\s+/g, ' ').trim();
  if (!name) return t.nameRequired;
  if (name.length > NAME_MAX) return t.nameTooLong;
  if ((state.project?.scenarios ?? []).some((scenario) => scenario.name === name)) return t.nameTaken(name);
  return undefined;
}

/** Le contrat déclaré, s'il l'est : les entrées déduites (facultatives au choix) et les sorties retenues. */
export function declaredOf(w: WizardUi, contract: BlockContract | undefined): DeclaredContract | undefined {
  if (!w.declare || !contract) return undefined;
  const derived = contract.outputs.map((output) => output.key);
  return {
    inputs: contract.inputs.map((input) => ({ key: input.key, required: !w.optional.includes(input.key) })),
    outputs: (w.outputs ?? derived).filter((key) => derived.includes(key)),
    preconditions: [],
    postconditions: [],
  };
}

export const checkKey = (w: WizardUi, declared: DeclaredContract | undefined): string =>
  `${sourceKey(w)}|${w.name.trim()}|${JSON.stringify(declared ?? null)}`;

/** Peut-on passer à l'étape suivante ? (étape 1 : nom valable et source lue avec des étapes). */
export function stepReady(state: DashboardState, w: WizardUi, step: WizardStep): boolean {
  if (step === 1) {
    const source = sourceOf(w);
    return nameProblem(state, w) === undefined && source !== undefined && source.steps > 0;
  }
  return true;
}

function field(label: string, control: string, hint = '', id = ''): string {
  return `<label class="field wz-field"${id ? ` id="${id}"` : ''}><span>${label}</span>${control}${hint}</label>`;
}

function infoStep(state: DashboardState, w: WizardUi): string {
  const t = wizardText(state);
  const p = state.project;
  const scenarios = (p?.scenarios ?? []).filter(
    (scenario) => !scenario.reusable && scenario.format === 'yaml',
  );
  const source = sourceOf(w);
  const problem = w.name ? nameProblem(state, w) : undefined;
  const origin = `<fieldset class="wz-origin"><legend>${esc(t.origin)}</legend><label class="wz-radio"><input type="radio" name="wz-origin" data-wz="origin" value="scenario"${w.origin === 'scenario' ? ' checked' : ''}><span>${esc(t.originScenario)}</span></label><label class="wz-radio"><input type="radio" name="wz-origin" data-wz="origin" value="recording"${w.origin === 'recording' ? ' checked' : ''}><span>${esc(t.originRecording)}</span></label></fieldset>`;
  const select = (
    key: string,
    label: string,
    current: string,
    options: readonly (readonly [string, string])[],
    empty: string,
  ): string =>
    options.length === 0
      ? `<p class="mu wz-empty">${esc(empty)}</p>`
      : field(
          esc(label),
          `<select data-wz="${key}"><option value=""${current ? '' : ' selected'} disabled>—</option>${options.map(([value, text]) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(text)}</option>`).join('')}</select>`,
        );
  const sourceFields =
    w.origin === 'scenario'
      ? select(
          'scenario',
          t.scenario,
          w.scenario,
          scenarios.map((scenario) => [scenario.name, scenario.name] as const),
          t.noScenario,
        )
      : `${select(
          'recording',
          t.recording,
          w.recording,
          (w.recordings ?? []).map((name) => [name, name] as const),
          t.noRecording,
        )}${
          w.recording
            ? w.groups && w.groupsFor === w.recording && w.groups.length === 0
              ? `<p class="mu wz-empty">${esc(t.noGroup)}</p>`
              : select(
                  'group',
                  t.group,
                  w.groupId,
                  (w.groupsFor === w.recording ? (w.groups ?? []) : []).map(
                    (group) => [group.id, `${group.name} · ${String(group.stepIds.length)}`] as const,
                  ),
                  t.noGroup,
                )
            : ''
        }${
          w.groupId && w.groupSteps && w.groupSteps.length > 0
            ? `<fieldset class="wz-steps-pick"><legend>${esc(t.stepsPick)}</legend><ul class="plain tight">${w.groupSteps
                .map(
                  (step) =>
                    `<li><label class="wz-check"><input type="checkbox" data-wz="step" value="${esc(step.stepId ?? '')}"${!w.stepIds || w.stepIds.includes(step.stepId ?? '') ? ' checked' : ''}><span>${String(step.position)}. ${esc(step.label)}</span></label></li>`,
                )
                .join('')}</ul></fieldset>`
            : ''
        }`;
  const status = w.loading
    ? `<p class="mu wz-status" role="status"><span class="spin" aria-hidden="true"></span> ${esc(t.loading)}</p>`
    : source
      ? `<p class="wz-status ${source.steps > 0 ? 'ok' : 'ko'}" role="status">${icon(source.steps > 0 ? 'check' : 'alert')}<span>${esc(source.steps > 0 ? t.sourceSteps(source.steps, source.startAt) : t.noSteps)}</span></p>`
      : '';
  return `<h3 class="wz-h">${esc(t.infoTitle)}</h3>${field(
    `${esc(t.name)} <b class="req" aria-hidden="true">*</b>`,
    `<input data-wz="name" value="${esc(w.name)}" maxlength="${String(NAME_MAX + 20)}" required autocomplete="off" placeholder="${esc(t.namePlaceholder)}" aria-invalid="${String(problem !== undefined)}" aria-describedby="wz-name-hint">`,
    `<small id="wz-name-hint" class="${problem ? 'err' : 'mu'}">${esc(problem ?? '')}</small>`,
  )}${field(esc(t.description), `<textarea data-wz="description" rows="3" maxlength="500" placeholder="${esc(t.descriptionPlaceholder)}">${esc(w.description)}</textarea>`)}<div class="wz-row">${field(esc(t.category), `<input value="${esc(source ? t.categoryOf(source.originLabel) : '—')}" readonly aria-readonly="true">`)}${field(esc(t.version), '<input value="v1" readonly aria-readonly="true">', `<small class="mu">${esc(t.versionNote)}</small>`)}</div><div class="wz-type" role="group" aria-label="${esc(t.type)}"><span class="wz-type-l">${esc(t.type)}</span><div class="wz-type-c sel"><span class="wz-type-ic" aria-hidden="true">${icon('cube')}</span><span><b>${esc(t.typeStandard)}</b><small class="mu">${esc(t.typeStandardHint)}</small></span>${icon('check')}</div><small class="mu">${esc(t.typeNote)}</small></div>${origin}${sourceFields}${status}`;
}

function ioStep(state: DashboardState, w: WizardUi): string {
  const t = wizardText(state);
  const source = sourceOf(w);
  if (!source) return `<p class="mu">${esc(t.loading)}</p>`;
  const dynamic = new Map(source.data.map((entry) => [entry.key, entry.dynamic]));
  const inputs = source.contract.inputs;
  const outputs = source.contract.outputs;
  const kept = w.outputs ?? outputs.map((output) => output.key);
  const inputRows = inputs.length
    ? `<table class="wz-table"><thead><tr><th>${esc(t.key)}</th><th>${esc(t.kind)}</th><th>${esc(t.required)}</th></tr></thead><tbody>${inputs.map((input) => `<tr><td><code class="lib-key">${esc(input.key)}</code></td><td>${esc(t.kindInput)}</td><td>${esc(input.required && !w.optional.includes(input.key) ? t.requiredYes : t.requiredNo)}</td></tr>`).join('')}</tbody></table>`
    : `<p class="mu wz-empty">${esc(t.noInputs)}</p>`;
  const outputRows = outputs.length
    ? `<table class="wz-table"><thead><tr><th>${esc(t.key)}</th><th>${esc(t.kind)}</th>${w.declare ? `<th><span class="sr">${esc(t.declared)}</span></th>` : ''}</tr></thead><tbody>${outputs.map((output) => `<tr><td><code class="lib-key">${esc(output.key)}</code></td><td>${esc(dynamic.get(output.key) ? t.kindDynamic : t.kindFixed)}</td>${w.declare ? `<td><input type="checkbox" data-wz="output" value="${esc(output.key)}" aria-label="${esc(t.keepOutput(output.key))}"${kept.includes(output.key) ? ' checked' : ''}></td>` : ''}</tr>`).join('')}</tbody></table>`
    : `<p class="mu wz-empty">${esc(t.noOutputs)}</p>`;
  const missing = source.missing.length
    ? `<div class="wz-alert ko">${icon('alert')}<div><b>${esc(t.missing)}</b><p>${source.missing.map((key) => `<code class="lib-key">${esc(key)}</code>`).join(' ')}</p></div></div>`
    : '';
  return `<h3 class="wz-h">${esc(t.ioTitle)} <span class="jn-chip ${w.declare ? 'warn' : 'ok'}">${esc(w.declare ? t.declared : t.derived)}</span></h3><label class="wz-check"><input type="checkbox" data-wz="declare"${w.declare ? ' checked' : ''}><span>${esc(t.declareToggle)}</span></label><section class="wz-sec"><h4>${esc(t.inputs)} <small class="mu">(${String(inputs.length)})</small></h4>${inputRows}</section><section class="wz-sec"><h4>${esc(t.outputs)} <small class="mu">(${String(w.declare ? kept.filter((key) => outputs.some((output) => output.key === key)).length : outputs.length)})</small></h4>${outputRows}</section>${missing}`;
}

function paramsStep(state: DashboardState, w: WizardUi): string {
  const t = wizardText(state);
  const source = sourceOf(w);
  const inputs = source?.contract.inputs ?? [];
  const rows = inputs.length
    ? `<table class="wz-table"><thead><tr><th>${esc(t.param)}</th><th>${esc(t.kind)}</th><th>${esc(t.default)}</th><th>${esc(t.mapping)}</th><th>${esc(t.required)}</th></tr></thead><tbody>${inputs
        .map(
          (input) =>
            `<tr><td><code class="lib-key">${esc(input.key)}</code></td><td>${esc(t.kindInput)}</td><td class="mu">${esc(t.defaultNone)}</td><td class="mu">${esc(t.mappingNone)}</td><td><label class="wz-check"><input type="checkbox" data-wz="optional" value="${esc(input.key)}"${w.optional.includes(input.key) || !input.required ? ' checked' : ''}${input.required ? '' : ' disabled'}><span>${esc(t.optionalToggle(input.key))}</span></label></td></tr>`,
        )
        .join('')}</tbody></table>`
    : `<p class="mu wz-empty">${esc(t.noParams)}</p>`;
  return `<h3 class="wz-h">${esc(t.paramsTitle)} <small class="mu">(${String(inputs.length)})</small></h3><p class="mu">${esc(t.paramsIntro)}</p>${rows}`;
}

function confirmStep(state: DashboardState, w: WizardUi): string {
  const t = wizardText(state);
  const source = sourceOf(w);
  const declared = declaredOf(w, source?.contract);
  const fresh = w.check && w.checkFor === checkKey(w, declared) ? w.check : undefined;
  const inputs = source?.contract.inputs ?? [];
  const outputs = declared ? declared.outputs : (source?.contract.outputs.map((output) => output.key) ?? []);
  const row = (label: string, value: string): string => `<dt>${esc(label)}</dt><dd>${value}</dd>`;
  const summary = `<dl class="jn-dl wz-dl">${row(t.name, esc(w.name.trim()))}${row(t.description, esc(w.description.trim() || '—'))}${row(t.category, esc(source ? t.categoryOf(source.originLabel) : '—'))}${row(t.version, 'v1')}${row(t.originLabel, esc(source?.originLabel ?? '—'))}${row(t.stepsCount, String(source?.steps ?? 0))}${row(t.inputs, inputs.length ? inputs.map((input) => `<code class="lib-key">${esc(input.key)}</code>`).join(' ') : `<small class="mu">—</small>`)}${row(t.outputs, outputs.length ? outputs.map((key) => `<code class="lib-key">${esc(key)}</code>`).join(' ') : `<small class="mu">—</small>`)}${row(t.paramsTitle, String(inputs.length))}${row(t.ioTitle, esc(declared ? t.declared : t.derived))}</dl>`;
  const needs = inputs.length > 0 ? [t.needsInputs(inputs.length)] : [];
  const checks = w.checking
    ? `<p class="wz-status" role="status"><span class="spin" aria-hidden="true"></span> ${esc(t.checking)}</p>`
    : fresh
      ? `<p class="wz-status ${fresh.ok ? 'ok' : 'ko'}" role="status">${icon(fresh.ok ? 'check' : 'alert')}<span>${esc(fresh.ok ? t.checkOk : t.checkKo)}</span></p>${fresh.errors.length ? `<div class="wz-alert ko"><div><b>${esc(t.errors)}</b><ul class="plain tight">${fresh.errors.map((error) => `<li>${esc(error)}</li>`).join('')}</ul><button type="button" class="btn small" data-action="wz-goto" data-step="${/contract|declares|input/i.test(fresh.errors.join(' ')) ? '2' : '1'}">${esc(t.fixAt(t.steps[/contract|declares|input/i.test(fresh.errors.join(' ')) ? 1 : 0] ?? ''))}</button></div></div>` : ''}${[...fresh.warnings, ...needs].length ? `<div class="wz-alert warn"><div><b>${esc(t.warnings)}</b><ul class="plain tight">${[...fresh.warnings, ...needs].map((warning) => `<li>${esc(warning)}</li>`).join('')}</ul></div></div>` : ''}`
      : '';
  return `<h3 class="wz-h">${esc(t.confirmTitle)}</h3>${summary}<section class="wz-sec"><h4>${esc(t.checksTitle)}</h4>${checks}</section>`;
}

/** La fenêtre entière : en-tête, étapes, corps en deux colonnes (formulaire, aide), pied fixe. */
export function wizardView(state: DashboardState): string {
  const w = state.lib.wizard;
  if (!w || !state.project) return '';
  const t = wizardText(state);
  const source = sourceOf(w);
  const declared = declaredOf(w, source?.contract);
  const fresh = w.check && w.checkFor === checkKey(w, declared) ? w.check : undefined;
  const stepper = `<ol class="wz-stepper">${t.steps
    .map((label, index) => {
      const n = (index + 1) as WizardStep;
      const done = n < w.step;
      const current = n === w.step;
      // Une étape s'atteint quand toutes les précédentes sont prêtes (revenir ne perd rien).
      const reachable = ([1, 2, 3] as const).filter((at) => at < n).every((at) => stepReady(state, w, at));
      return `<li class="${done ? 'done' : current ? 'cur' : ''}"><button type="button" data-action="wz-goto" data-step="${String(n)}"${reachable && !current ? '' : ' disabled'} aria-current="${current ? 'step' : 'false'}" aria-label="${esc(t.stepLabel(n, label, done ? t.stateDone : current ? t.stateCurrent : t.stateTodo))}"><span class="wz-n" aria-hidden="true">${done ? icon('check') : String(n)}</span><span>${esc(label)}</span></button></li>`;
    })
    .join('')}</ol>`;
  const body =
    w.step === 1
      ? infoStep(state, w)
      : w.step === 2
        ? ioStep(state, w)
        : w.step === 3
          ? paramsStep(state, w)
          : confirmStep(state, w);
  const help = `<aside class="wz-help" aria-label="${esc(t.helpTitle)}"><span class="wz-help-ic" aria-hidden="true">${icon('cube')}<span>+</span></span><b>${esc(t.helpTitle)}</b><ul class="plain">${(t.help[w.step - 1] ?? []).map((line) => `<li>${icon('check')}<span>${esc(line)}</span></li>`).join('')}</ul></aside>`;
  const ready = stepReady(state, w, w.step);
  const footer = `<div class="wz-foot"><button type="button" class="btn" data-action="wz-cancel">${esc(t.cancel)}</button><span class="wz-foot-r">${w.step > 1 ? `<button type="button" class="btn" data-action="wz-prev">${icon('back')}<span>${esc(t.previous)}</span></button>` : ''}${
    w.step < 4
      ? `<button type="button" class="btn primary" data-action="wz-next"${ready && !w.loading ? '' : ' disabled'}><span>${esc(t.next)}</span>${icon('right')}</button>`
      : `<button type="button" class="btn primary" data-action="wz-create"${fresh?.ok && !w.busy && !w.checking ? '' : ' disabled'} aria-busy="${String(Boolean(w.busy))}">${icon('cube')}<span>${esc(w.busy ? t.creating : t.create)}</span></button>`
  }</span></div>`;
  const discard = w.confirmClose
    ? `<div class="wz-discard" role="alertdialog" aria-labelledby="wz-discard-t"><b id="wz-discard-t">${esc(t.discardTitle)}</b><p>${esc(t.discardText)}</p><div class="form-acts start"><button type="button" class="btn primary" data-action="wz-discard-yes">${esc(t.discardYes)}</button><button type="button" class="btn" data-action="wz-discard-no">${esc(t.discardNo)}</button></div></div>`
    : '';
  return `<div class="wz-bg" data-action="wz-cancel"></div><div class="wz" role="dialog" aria-modal="true" aria-labelledby="wz-t" aria-describedby="wz-sub"><div class="wz-head"><span class="wz-ic" aria-hidden="true">${icon('cube')}</span><div><h2 id="wz-t">${esc(t.title)}</h2><p id="wz-sub" class="mu">${esc(t.subtitle)}</p></div><button type="button" class="btn small ghost icon-only" data-action="wz-cancel" aria-label="${esc(t.close)}" title="${esc(t.close)}">${icon('close')}</button></div>${stepper}<div class="wz-body"><div class="wz-main">${w.error ? `<p class="err" role="alert">${esc(w.error)}</p>` : ''}${body}</div>${help}</div>${footer}${discard}</div>`;
}

export const WIZARD_CSS = `
.wz-bg{position:fixed;inset:0;z-index:60;background:color-mix(in srgb,var(--qa-color-text) 38%,transparent)}
.wz{position:fixed;z-index:61;left:50%;top:50%;transform:translate(-50%,-50%);width:min(980px,calc(100vw - 32px));max-height:calc(100vh - 32px);display:flex;flex-direction:column;border-radius:14px;background:var(--qa-color-surface);box-shadow:0 24px 60px color-mix(in srgb,var(--qa-color-text) 28%,transparent);overflow:hidden}
.wz-head{display:flex;align-items:flex-start;gap:12px;padding:18px 20px 10px}
.wz-head>div{flex:1;min-width:0}
.wz-head h2{margin:0;font-size:20px}
.wz-head p{margin:2px 0 0}
.wz-ic{width:36px;height:36px;display:grid;place-items:center;color:var(--qa-color-primary)}
.wz-ic .ico{width:30px;height:30px}
.wz-stepper{list-style:none;margin:0;padding:6px 20px 12px;display:flex;gap:8px;border-bottom:1px solid var(--qa-color-border);overflow-x:auto}
.wz-stepper li{flex:1;display:flex;align-items:center;min-width:max-content}
.wz-stepper li:not(:last-child)::after{content:"";flex:1;min-width:16px;height:1px;margin:0 10px;background:var(--qa-color-border-strong)}
.wz-stepper button{display:inline-flex;align-items:center;gap:8px;border:0;background:none;font:inherit;font-size:13px;font-weight:600;color:var(--qa-color-muted);padding:4px;border-radius:8px;cursor:pointer}
.wz-stepper button:disabled{cursor:default}
.wz-n{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;border:1.5px solid var(--qa-color-border-strong);font-size:12.5px;background:var(--qa-color-surface)}
.wz-n .ico{width:14px;height:14px}
.wz-stepper .cur button{color:var(--qa-color-text)}
.wz-stepper .cur .wz-n{background:var(--qa-color-primary);border-color:var(--qa-color-primary);color:var(--qa-color-surface)}
.wz-stepper .done .wz-n{background:var(--qa-color-primary-soft);border-color:var(--qa-color-primary);color:var(--qa-color-primary-2)}
.wz-body{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:16px;padding:16px 20px;overflow:auto}
.wz-main{display:flex;flex-direction:column;gap:12px;min-width:0;padding:14px;border:1px solid var(--qa-color-border);border-radius:12px}
.wz-h{margin:0;font-size:15px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wz-field{display:flex;flex-direction:column;gap:4px}
.wz-field input,.wz-field select,.wz-field textarea{min-height:36px;border-radius:8px;border:1px solid var(--qa-color-border-strong);background:var(--qa-color-surface);font:inherit;padding:6px 10px;color:var(--qa-color-text)}
.wz-field input[readonly]{background:var(--qa-color-surface-2);color:var(--qa-color-muted)}
.wz-field .req{color:var(--qa-color-danger)}
.wz-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}
.wz-type{display:flex;flex-direction:column;gap:6px}
.wz-type-l{font-size:13px;font-weight:600}
.wz-type-c{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1.5px solid var(--qa-color-primary);border-radius:10px;background:var(--qa-color-primary-soft)}
.wz-type-c>span:nth-child(2){flex:1;display:flex;flex-direction:column}
.wz-type-c>.ico{color:var(--qa-color-primary);width:18px;height:18px}
.wz-type-ic{color:var(--qa-color-primary)}
.wz-type-ic .ico{width:20px;height:20px}
.wz-origin,.wz-steps-pick{border:1px solid var(--qa-color-border);border-radius:10px;padding:8px 12px;margin:0;display:flex;flex-direction:column;gap:6px}
.wz-origin legend,.wz-steps-pick legend{font-size:13px;font-weight:600;padding:0 4px}
.wz-steps-pick ul{max-height:180px;overflow:auto}
.wz-radio,.wz-check{display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer}
.wz-status{display:flex;align-items:center;gap:8px;margin:0;padding:8px 10px;border-radius:8px;font-size:13px;background:var(--qa-color-surface-2)}
.wz-status .ico{width:16px;height:16px;flex:none}
.wz-status.ok{background:var(--qa-color-primary-soft);color:var(--qa-color-primary-2)}
.wz-status.ko{background:var(--qa-color-danger-soft);color:var(--qa-color-danger)}
.wz-empty{margin:0;padding:10px;border:1px dashed var(--qa-color-border-strong);border-radius:8px}
.wz-sec{display:flex;flex-direction:column;gap:6px}
.wz-sec h4{margin:0;font-size:13.5px}
.wz-table{width:100%;border-collapse:collapse;font-size:13px}
.wz-table th{text-align:left;font-weight:600;color:var(--qa-color-muted);border-bottom:1px solid var(--qa-color-border);padding:6px 8px}
.wz-table td{border-bottom:1px solid var(--qa-color-border);padding:6px 8px;vertical-align:middle}
.wz-alert{display:flex;gap:8px;padding:10px 12px;border-radius:10px;font-size:13px}
.wz-alert p{margin:4px 0 0}
.wz-alert.ko{background:var(--qa-color-danger-soft);color:var(--qa-color-danger)}
.wz-alert.warn{background:var(--qa-color-warning-soft);color:color-mix(in srgb,var(--qa-color-warning) 75%,var(--qa-color-text))}
.wz-alert>.ico{width:16px;height:16px;flex:none;margin-top:2px}
.wz-alert .btn{margin-top:6px}
.wz-dl{grid-template-columns:150px minmax(0,1fr);font-size:13px}
.wz-help{display:flex;flex-direction:column;align-items:center;gap:10px;padding:22px 18px;border-radius:12px;background:var(--qa-color-primary-soft-2);border:1px solid color-mix(in srgb,var(--qa-color-primary) 18%,var(--qa-color-border));text-align:center}
.wz-help-ic{position:relative;color:var(--qa-color-primary)}
.wz-help-ic .ico{width:56px;height:56px}
.wz-help-ic span{position:absolute;right:-6px;bottom:-4px;width:22px;height:22px;border-radius:50%;background:var(--qa-color-primary);color:var(--qa-color-surface);font-weight:800;display:grid;place-items:center;font-size:15px}
.wz-help ul{text-align:left;gap:10px;font-size:13px}
.wz-help li{display:flex;gap:8px;align-items:flex-start}
.wz-help li .ico{width:15px;height:15px;flex:none;color:var(--qa-color-primary);margin-top:2px}
.wz-foot{display:flex;align-items:center;gap:10px;padding:12px 20px;border-top:1px solid var(--qa-color-border);background:var(--qa-color-surface)}
.wz-foot-r{display:flex;gap:8px;margin-left:auto}
.wz-foot .btn{display:inline-flex;align-items:center;gap:6px}
.wz-discard{position:absolute;inset:auto 20px 70px auto;z-index:2;max-width:360px;padding:14px;border:1px solid var(--qa-color-border);border-radius:12px;background:var(--qa-color-surface);box-shadow:0 10px 30px color-mix(in srgb,var(--qa-color-text) 22%,transparent)}
.wz-discard p{margin:4px 0 10px;font-size:13px}
@media (max-width:760px){
  .wz{top:16px;transform:translateX(-50%);max-height:calc(100vh - 32px)}
  .wz-body{grid-template-columns:minmax(0,1fr)}
  .wz-help{display:none}
  .wz-row{grid-template-columns:minmax(0,1fr)}
  .wz-stepper span:not(.wz-n){display:none}
}
`;

// ── Contrôleur ──────────────────────────────────────────────────────────────────────────────────

export interface WizardHost {
  state: DashboardState;
  root: ShadowRoot | HTMLElement;
  api(): QaCrawlerClient | undefined;
  paint(): void;
  /** Recharge le projet et la bibliothèque après une création. */
  reload(): Promise<void>;
}

const message = (error: unknown): string =>
  error instanceof QaCrawlerError
    ? [error.message, ...error.details.slice(1)].join(' · ')
    : error instanceof Error
      ? error.message
      : String(error);

/** Le contrôleur de la fenêtre : actions `wz-*`, champs `data-wz`, clavier, appels réels au serveur. */
export class LibraryWizard {
  private opener?: HTMLElement;
  private sequence = 0;

  constructor(private readonly host: WizardHost) {}

  private get w(): WizardUi | undefined {
    return this.host.state.lib.wizard;
  }

  private projectId(): string | undefined {
    return this.host.state.project?.id;
  }

  private focus(selector: string): void {
    this.host.root.querySelector<HTMLElement>(selector)?.focus();
  }

  open(scenario?: string): void {
    const scenarios = (this.host.state.project?.scenarios ?? []).filter(
      (entry) => !entry.reusable && entry.format === 'yaml',
    );
    const chosen =
      scenario && scenarios.some((entry) => entry.name === scenario) ? scenario : (scenarios[0]?.name ?? '');
    this.opener =
      (this.host.root as ShadowRoot).activeElement instanceof HTMLElement
        ? ((this.host.root as ShadowRoot).activeElement as HTMLElement)
        : undefined;
    this.host.state.lib.wizard = emptyWizard(chosen);
    this.host.paint();
    // Les lectures commencent (et redessinent) avant que le focus soit posé dans la fenêtre.
    void this.loadPreview();
    void this.loadRecordings();
    this.focus('.wz [data-wz="name"]');
  }

  /** Fermer : sans perte silencieuse (une confirmation dans la fenêtre si quelque chose a été saisi). */
  close(force = false): void {
    const w = this.w;
    if (!w) return;
    if (!force && w.dirty && !w.confirmClose) {
      w.confirmClose = true;
      this.host.paint();
      this.focus('[data-action="wz-discard-no"]');
      return;
    }
    this.host.state.lib.wizard = undefined;
    this.host.paint();
    if (this.opener?.isConnected) this.opener.focus();
    else this.focus('.hd [data-action="lib-panel-open"]');
  }

  private async loadPreview(): Promise<void> {
    const api = this.host.api();
    const projectId = this.projectId();
    const w = this.w;
    if (!api || !projectId || !w || w.origin !== 'scenario' || !w.scenario) return;
    const key = sourceKey(w);
    w.loading = true;
    this.host.paint();
    try {
      const preview = await api.library.preview(projectId, w.scenario);
      if (this.w !== w || sourceKey(w) !== key) return;
      w.preview = preview;
      w.previewFor = key;
      w.error = undefined;
    } catch (error) {
      w.error = message(error);
    }
    w.loading = false;
    this.host.paint();
  }

  private async loadRecordings(): Promise<void> {
    const api = this.host.api();
    const projectId = this.projectId();
    const w = this.w;
    if (!api || !projectId || !w) return;
    try {
      const recordings = await api.recordings.list(projectId);
      if (this.w !== w) return;
      w.recordings = recordings
        .map((recording) => recording.name)
        .filter((name): name is string => Boolean(name));
      this.host.paint();
    } catch {
      w.recordings = [];
    }
  }

  private async loadGroups(): Promise<void> {
    const api = this.host.api();
    const projectId = this.projectId();
    const w = this.w;
    if (!api || !projectId || !w?.recording) return;
    const recording = w.recording;
    w.loading = true;
    this.host.paint();
    try {
      const groups = await api.groups.list(projectId, recording);
      if (this.w !== w || w.recording !== recording) return;
      w.groups = groups;
      w.groupsFor = recording;
      w.error = undefined;
    } catch (error) {
      w.error = message(error);
    }
    w.loading = false;
    this.host.paint();
  }

  private extractionInput(w: WizardUi): ExtractionInput {
    const name = w.name.replace(/\s+/g, ' ').trim();
    const description = w.description.trim();
    return {
      selection: [{ groupId: w.groupId, ...(w.stepIds ? { stepIds: w.stepIds } : {}) }],
      mode: 'separate',
      ...(name ? { names: { [w.groupId]: { name, ...(description ? { description } : {}) } } } : {}),
    };
  }

  private async loadPlan(): Promise<void> {
    const api = this.host.api();
    const projectId = this.projectId();
    const w = this.w;
    if (!api || !projectId || !w || w.origin !== 'recording' || !w.recording || !w.groupId) return;
    const key = sourceKey(w);
    w.loading = true;
    this.host.paint();
    try {
      const plan = await api.library.planExtraction(projectId, w.recording, this.extractionInput(w));
      if (this.w !== w || sourceKey(w) !== key) return;
      w.plan = plan;
      w.planFor = key;
      if (!w.stepIds) w.groupSteps = plan.blocks[0]?.steps ?? [];
      w.error = plan.errors[0];
    } catch (error) {
      w.error = message(error);
    }
    w.loading = false;
    this.host.paint();
  }

  /** Les vérifications réelles de l'étape 4 (rien n'est écrit). */
  private async runCheck(): Promise<void> {
    const api = this.host.api();
    const projectId = this.projectId();
    const w = this.w;
    if (!api || !projectId || !w) return;
    const source = sourceOf(w);
    const declared = declaredOf(w, source?.contract);
    const key = checkKey(w, declared);
    const run = ++this.sequence;
    w.checking = true;
    this.host.paint();
    try {
      const name = w.name.replace(/\s+/g, ' ').trim();
      const local = nameProblem(this.host.state, w);
      if (w.origin === 'scenario') {
        const result = await api.library.check(projectId, {
          scenario: w.scenario,
          name,
          ...(declared ? { contract: declared } : {}),
        });
        if (run !== this.sequence || this.w !== w) return;
        w.check = {
          ok: result.ok && !local,
          errors: [...(local ? [local] : []), ...result.errors],
          warnings: result.warnings,
        };
      } else {
        const plan = await api.library.planExtraction(projectId, w.recording, this.extractionInput(w));
        if (run !== this.sequence || this.w !== w) return;
        const block = plan.blocks[0];
        const errors = [...(local ? [local] : []), ...plan.errors, ...(block?.validation.errors ?? [])];
        if (!block || block.steps.length === 0) errors.push(wizardText(this.host.state).noSteps);
        w.check = { ok: errors.length === 0, errors, warnings: block?.validation.warnings ?? [] };
      }
      w.checkFor = key;
    } catch (error) {
      if (run !== this.sequence || this.w !== w) return;
      w.check = { ok: false, errors: [message(error)], warnings: [] };
      w.checkFor = key;
    }
    w.checking = false;
    this.host.paint();
  }

  private async create(): Promise<void> {
    const api = this.host.api();
    const projectId = this.projectId();
    const w = this.w;
    if (!api || !projectId || !w || w.busy) return;
    const source = sourceOf(w);
    const declared = declaredOf(w, source?.contract);
    const fresh = w.check && w.checkFor === checkKey(w, declared) ? w.check : undefined;
    if (!fresh?.ok) return;
    w.busy = true;
    w.error = undefined;
    this.host.paint();
    const name = w.name.replace(/\s+/g, ' ').trim();
    const description = w.description.trim();
    try {
      if (w.origin === 'scenario')
        await api.library.add(projectId, {
          from: 'scenario',
          scenario: w.scenario,
          name,
          ...(description ? { description } : {}),
          ...(declared ? { contract: declared } : {}),
        });
      else {
        await api.library.publishExtraction(projectId, w.recording, this.extractionInput(w));
        if (declared) await api.library.declareContract(projectId, name, declared);
      }
      this.host.state.lib.wizard = undefined;
      this.host.state.lib.notice = wizardText(this.host.state).created(name);
      await this.host.reload();
      this.host.paint();
      if (this.opener?.isConnected) this.opener.focus();
    } catch (error) {
      // L'échec garde tout ce qui a été saisi.
      w.busy = false;
      w.error = message(error);
      this.host.paint();
    }
  }

  private go(step: WizardStep): void {
    const w = this.w;
    if (!w) return;
    for (let at = 1 as WizardStep; at < step; at = (at + 1) as WizardStep)
      if (!stepReady(this.host.state, w, at)) return;
    w.step = step;
    w.error = undefined;
    this.host.paint();
    this.focus('.wz-main input:not([readonly]), .wz-main select, .wz-main textarea, .wz-main button');
    if (step === 4) void this.runCheck();
  }

  click(action: string, target: HTMLElement): boolean {
    const w = this.w;
    if (!action.startsWith('wz-')) return false;
    if (!w) return true;
    switch (action) {
      case 'wz-cancel':
        this.close();
        return true;
      case 'wz-discard-yes':
        this.close(true);
        return true;
      case 'wz-discard-no':
        w.confirmClose = false;
        this.host.paint();
        this.focus('.wz [data-wz="name"], .wz-main button');
        return true;
      case 'wz-next':
        if (w.step < 4) this.go((w.step + 1) as WizardStep);
        return true;
      case 'wz-prev':
        if (w.step > 1) this.go((w.step - 1) as WizardStep);
        return true;
      case 'wz-goto': {
        const step = Number(target.dataset.step);
        if (step >= 1 && step <= 4) this.go(step as WizardStep);
        return true;
      }
      case 'wz-create':
        void this.create();
        return true;
      default:
        return true;
    }
  }

  field(target: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, committed: boolean): boolean {
    const key = target.dataset.wz;
    const w = this.w;
    if (key === undefined || !w) return false;
    const value = target.value;
    const checked = target instanceof HTMLInputElement && target.checked;
    w.dirty = true;
    switch (key) {
      case 'name':
        w.name = value;
        // L'indication du nom suit la saisie sans redessin complet (le focus reste dans le champ).
        this.refreshName();
        return true;
      case 'description':
        w.description = value;
        return true;
      case 'origin':
        if (!committed) return true;
        w.origin = value === 'recording' ? 'recording' : 'scenario';
        w.error = undefined;
        this.host.paint();
        if (w.origin === 'scenario') void this.loadPreview();
        return true;
      case 'scenario':
        w.scenario = value;
        w.error = undefined;
        void this.loadPreview();
        return true;
      case 'recording':
        w.recording = value;
        w.groupId = '';
        w.stepIds = undefined;
        w.groupSteps = undefined;
        void this.loadGroups();
        return true;
      case 'group':
        w.groupId = value;
        w.stepIds = undefined;
        w.groupSteps = undefined;
        void this.loadPlan();
        return true;
      case 'step': {
        const all = (w.groupSteps ?? []).map((step) => step.stepId ?? '').filter(Boolean);
        const current = new Set(w.stepIds ?? all);
        if (checked) current.add(value);
        else current.delete(value);
        const kept = all.filter((id) => current.has(id));
        w.stepIds = kept.length === all.length ? undefined : kept;
        void this.loadPlan();
        return true;
      }
      case 'declare':
        w.declare = checked;
        this.host.paint();
        return true;
      case 'output': {
        const outputs = sourceOf(w)?.contract.outputs.map((output) => output.key) ?? [];
        const current = new Set(w.outputs ?? outputs);
        if (checked) current.add(value);
        else current.delete(value);
        w.outputs = outputs.filter((entry) => current.has(entry));
        this.host.paint();
        return true;
      }
      case 'optional':
        w.optional = checked
          ? [...new Set([...w.optional, value])]
          : w.optional.filter((entry) => entry !== value);
        // Rendre une entrée facultative, c'est déclarer le contrat.
        if (w.optional.length > 0) w.declare = true;
        this.host.paint();
        return true;
      default:
        return true;
    }
  }

  private refreshName(): void {
    const w = this.w;
    if (!w) return;
    const problem = w.name ? nameProblem(this.host.state, w) : undefined;
    const hint = this.host.root.querySelector<HTMLElement>('#wz-name-hint');
    const input = this.host.root.querySelector<HTMLInputElement>('.wz [data-wz="name"]');
    if (hint) {
      hint.textContent = problem ?? '';
      hint.className = problem ? 'err' : 'mu';
    }
    input?.setAttribute('aria-invalid', String(problem !== undefined));
    const next = this.host.root.querySelector<HTMLButtonElement>('[data-action="wz-next"]');
    if (next) next.disabled = !stepReady(this.host.state, w, w.step) || Boolean(w.loading);
  }

  /** Échap ferme (avec confirmation après une saisie) ; Tab reste dans la fenêtre. */
  keydown(event: KeyboardEvent): boolean {
    const w = this.w;
    if (!w) return false;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (w.confirmClose) {
        w.confirmClose = false;
        this.host.paint();
      } else this.close();
      return true;
    }
    if (event.key === 'Tab') {
      const items = [
        ...this.host.root.querySelectorAll<HTMLElement>(
          '.wz button:not([disabled]), .wz input:not([disabled]), .wz select, .wz textarea',
        ),
      ];
      const first = items[0];
      const last = items.at(-1);
      const active = (this.host.root as ShadowRoot).activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last?.focus();
        return true;
      }
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first?.focus();
        return true;
      }
    }
    return false;
  }
}
