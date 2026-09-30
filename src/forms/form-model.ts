import type { DiscoveredAction } from '../model/discovered-action.js';
import type { LocatorDescriptor } from '../model/locator.js';

/** Genre de valeur qu'attend un champ. */
export const FIELD_TYPES = [
  'text',
  'textarea',
  'email',
  'password',
  'tel',
  'url',
  'number',
  'date',
  'time',
  'datetime',
  'month',
  'week',
  'color',
  'range',
  'search',
  'select',
  'combobox',
  'autocomplete',
  'checkbox',
  'radio',
  'other',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface SelectOption {
  label: string;
  disabled: boolean;
  /** « -- », « Choisir… » : pas un vrai choix. */
  placeholder: boolean;
}

/**
 * Un champ d'un formulaire logique, tel que le formulaire l'attend. Sa valeur n'est
 * jamais lue ; les champs sensibles sont marqués et jamais remplis avec de vraies données.
 */
export interface FormField {
  /** Stable dans le formulaire (l'id de l'action qui le remplit). */
  id: string;
  name?: string;
  label?: string;
  /** Libellé du groupe (boutons radio : « Canal de contact »). */
  groupLabel?: string;
  /** Radios qui partagent un même choix. */
  choiceGroup?: string;
  type: FieldType;
  required: boolean;
  /** Qui déclare le champ obligatoire : attribut HTML required, aria-required. */
  requiredBy?: ('HTML' | 'ARIA')[];
  /** ANALYSE STATIQUE (preuves, pas des vérités) : concept prouvé, propriété d'API alimentée, validateurs du framework. */
  staticConcept?: string;
  staticProperty?: string;
  staticValidators?: { kind: string; value?: string | number }[];
  disabled: boolean;
  readonly: boolean;
  /** Attribut multiple (select, file, email). */
  multiple?: boolean;
  /** aria-invalid="true" au moment de l'observation. */
  ariaInvalid?: boolean;
  /** Propriétés ajoutées par le contrat d'API (enrichWithContract) : la page ne les déclare pas. */
  contractFilled?: (keyof FormField)[];
  min?: number;
  max?: number;
  /** min/max tels qu'écrits (dates, heures : "2026-01-01"). */
  minText?: string;
  maxText?: string;
  step?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /** Attribut inputmode (numeric, decimal…) : des chiffres sont attendus. */
  inputMode?: string;
  options?: SelectOption[];
  placeholder?: string;
  /** Texte d'aide affiché par l'application ("99999", "HH:MM"). */
  hint?: string;
  /** Contient déjà une valeur (la valeur elle-même n'est jamais lue). */
  hasValue: boolean;
  /** Empreinte salée de la valeur ; option choisie (code, libellé) ; état du framework (ng-valid). */
  valueDigest?: string;
  selectedValue?: string;
  selectedOption?: string;
  frameworkValid?: boolean;
  autofilled?: boolean;
  /** formControlName. */
  control?: string;
  sensitive: boolean;
  /** Carte, IBAN, compte bancaire… : jamais rempli, quelle que soit la source. */
  payment: boolean;
  locator: LocatorDescriptor;
}

/** Un message que l'application affiche à propos d'un champ (« Ce champ est obligatoire »). */
export interface ValidationMessage {
  fieldId: string;
  message: string;
}

/**
 * Un formulaire logique : les champs qu'un utilisateur remplit ensemble et les
 * boutons qui l'envoient ou le font avancer — un <form>, une fenêtre, un calque, ou
 * la page elle-même quand une application monopage n'a aucun <form>.
 */
export interface DiscoveredForm {
  /** `<stateId>:<group>` */
  id: string;
  stateId: string;
  /** form:<index>, layer:<nom> ou page. */
  group: string;
  /** Nom lisible : le titre de la fenêtre, sinon celui de l'écran. */
  name: string;
  fields: FormField[];
  /** Boutons qui envoient le formulaire ou font avancer un assistant. */
  submitActions: DiscoveredAction[];
  validationMessages: ValidationMessage[];
  /** Devant l'écran (fenêtre, tiroir). */
  foreground: boolean;
}

/** Une étape d'un plan de remplissage. Les champs sensibles n'y reçoivent jamais de valeur. */
export interface FormFillOperation {
  fieldId: string;
  operation: 'fill' | 'select' | 'check' | 'uncheck' | 'skip';
  /** Valeur saisie ou libellé de l'option ('' = première vraie option). Jamais définie pour un champ sensible. */
  value?: string;
  /** D'où vient la valeur. */
  source?: TestValueSource;
  reason?: string;
}

/** Que faire d'un formulaire : calculé par une FormFillStrategy, exécuté par le PlaywrightActionExecutor. */
export interface FormFillPlan {
  formId: string;
  operations: FormFillOperation[];
}

/** configured (testData.fields) > rule (testData.defaults, règles de sens) > type > fallback. */
export type TestValueSource = 'configured' | 'rule' | 'type' | 'fallback';

/** Une valeur pour un champ, et pourquoi. `skip` : laissé tel quel. */
export interface TestValue {
  kind: 'fill' | 'select' | 'check' | 'uncheck' | 'skip';
  value?: string;
  source: TestValueSource;
  reason?: string;
  /** Cas de validation : ce qui rend la valeur invalide ("empty", "above-max"…). */
  case?: string;
}

/** Ce qu'un TestDataProvider peut savoir du run. */
export interface TestDataContext {
  /** Id court du run ; chaque valeur créée porte QA-CRAWLER-<runId> quand c'est possible. */
  runId: string;
  formName?: string;
  stateId?: string;
}

/** Le marqueur qui rend les données créées identifiables (et, plus tard, nettoyables). */
export function runTag(runId: string): string {
  return `QA-CRAWLER-${runId}`;
}
