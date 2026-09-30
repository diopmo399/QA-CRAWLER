import type { LocatorDescriptor } from './locator.js';

/**
 * À quel point il est risqué de déclencher une action automatiquement.
 * - SAFE : lecture seule (navigation, onglets, détails, pagination, recherche, filtres, saisie d'un champ).
 * - MUTATION : modifie des données (créer, enregistrer, modifier, envoyer un formulaire…).
 * - DANGEROUS : destructive ou irréversible (supprimer, payer, envoyer, se déconnecter, données sensibles…).
 * - UNKNOWN : non reconnue ; traitée comme risquée et jamais exécutée automatiquement.
 */
export const ACTION_CLASSIFICATIONS = ['SAFE', 'MUTATION', 'DANGEROUS', 'UNKNOWN'] as const;
export type ActionClassification = (typeof ACTION_CLASSIFICATIONS)[number];

/** Ce que l'exécuteur fait de l'élément. */
export const ACTION_TYPES = ['click', 'navigate', 'fill', 'select', 'check', 'uncheck'] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/** Intention fonctionnelle, utilisée par le moteur de décision (priorités) et la politique de sécurité (liste permise par la mission). */
export const ACTION_CATEGORIES = [
  'navigation',
  'tab',
  'menu',
  'details',
  'pagination',
  'search',
  'filter',
  'form-input',
  'form-step',
  'submit',
  'toggle',
  'other',
] as const;
export type ActionCategory = (typeof ACTION_CATEGORIES)[number];

/** Pourquoi une action est risquée ; noms utilisables dans la liste `safety.block` de la mission. */
export const RISK_KINDS = [
  'delete',
  'payment',
  'send',
  'logout',
  'irreversible',
  'sensitive-data',
  'external-navigation',
  'form-submit',
  'mutation',
  'download',
] as const;
export type RiskKind = (typeof RISK_KINDS)[number];

/** Contraintes HTML d'un champ de formulaire — entrée du TestDataProvider et des tests de validation. */
export interface FieldConstraints {
  inputType: string;
  required: boolean;
  /** Qui déclare le champ obligatoire (attribut HTML, aria-required). */
  requiredBy?: ('HTML' | 'ARIA')[];
  readOnly?: boolean;
  multiple?: boolean;
  /** aria-invalid="true" au moment de l'observation. */
  ariaInvalid?: boolean;
  min?: string;
  max?: string;
  step?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /** Attribut inputmode (numeric, decimal…). */
  inputMode?: string;
  options?: string[];
  /** Options qu'on ne peut pas choisir. */
  disabledOptions?: string[];
  autocomplete?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  /** Texte d'aide affiché avec le champ ("99999", "HH:MM"…). */
  hint?: string;
  /** Le champ contient déjà une valeur (voir FormStateAnalyzer : garder, remplacer, observer). */
  hasValue?: boolean;
  /** Empreinte salée de la valeur courante (jamais la valeur), et de la valeur posée par le serveur. */
  valueDigest?: string;
  defaultValueDigest?: string;
  selectedValue?: string;
  selectedOption?: string;
  optionValues?: string[];
  choiceValue?: string;
  autofilled?: boolean;
  frameworkValid?: boolean;
  dirty?: boolean;
  touched?: boolean;
  /** Champ texte qui ouvre un calendrier. */
  dateLike?: boolean;
  /** Une liste qui n'est pas un <select> natif (Angular Material…). */
  customSelect?: boolean;
  /** Libellé du groupe d'une radio / case à cocher. */
  groupLabel?: string;
  /** Les radios d'un même choix partagent cette clé. */
  choiceGroup?: string;
  /** Attribut id du DOM (jamais utilisé pour localiser ; ignoré par la résolution sémantique s'il est généré). */
  elementId?: string;
  /** Nom accessible (aria-label, aria-labelledby…), quand il diffère du libellé. */
  accessibleName?: string;
  /** Nom du contrôle de formulaire du framework (Angular formControlName). */
  frameworkName?: string;
  /**
   * Ce que l'ANALYSE STATIQUE dit du champ (jamais une vérité d'exécution) : le concept
   * prouvé par le code et le contrat (email…), la propriété d'API qu'il alimente et ses
   * validateurs. Absent sans analyse statique.
   */
  staticConcept?: string;
  staticProperty?: string;
  staticValidators?: { kind: string; value?: string | number }[];
}

/** Une action utilisateur disponible sur un état donné. Données simples et sérialisables. */
export interface DiscoveredAction {
  /** Id stable : même état + même élément ⇒ même id d'un run à l'autre. */
  id: string;
  stateId: string;
  type: ActionType;
  category: ActionCategory;
  /** balise, ou balise[type] pour les inputs (a, button, input[email], select…). */
  elementType: string;
  role?: string;
  text?: string;
  label?: string;
  href?: string;
  /** Attribut name des champs. */
  name?: string;
  disabled: boolean;
  visible: boolean;
  /** aria-selected (onglets) : cliquer sur un onglet sélectionné ne change rien. */
  selected?: boolean;
  classification: ActionClassification;
  /** Pourquoi la SafetyPolicy a choisi ce classement. */
  reason: string;
  risks: RiskKind[];
  locator: LocatorDescriptor;
  /** Localisateur CSS utilisé quand le préféré ne correspond plus. */
  fallback?: LocatorDescriptor;
  /** Nom de la fenêtre à laquelle appartient l'élément. */
  dialogName?: string;
  /** Formulaire auquel appartient l'élément (son <form>, ou la fenêtre / le calque qui le contient). */
  formGroup?: string;
  /** Bouton qui envoie son formulaire (submit, « Soumettre », « Enregistrer »… dans un formulaire). */
  submitsForm?: boolean;
  /** Bouton d'envoi natif (button/input type=submit) : l'action principale de son formulaire. */
  nativeSubmit?: boolean;
  /** Devant l'écran (fenêtre, tiroir, menu ouvert, calque) : exploré en premier. */
  foreground?: boolean;
  /** Derrière un calque modal : pas cliquable tant que le calque est ouvert. */
  obscured?: boolean;
  /** Formulaire englobant, s'il y en a un. */
  formIndex?: number;
  /** Cible de lien hors des hôtes autorisés. */
  external?: boolean;
  /** Contraintes des actions fill / select / check. */
  field?: FieldConstraints;
}

/** Forme courte d'une action, enregistrée dans le graphe des flows et les rapports. */
export interface ActionSummary {
  type: ActionType;
  category: ActionCategory;
  text?: string;
  label?: string;
  href?: string;
  classification: ActionClassification;
}

export function summarizeAction(action: DiscoveredAction): ActionSummary {
  return {
    type: action.type,
    category: action.category,
    classification: action.classification,
    ...(action.text ? { text: action.text } : {}),
    ...(action.label ? { label: action.label } : {}),
    ...(action.href ? { href: action.href } : {}),
  };
}

/** Libellé lisible d'une action pour les logs : son texte, son libellé ou son nom. */
export function actionLabel(
  action: Pick<DiscoveredAction, 'text' | 'label' | 'name' | 'elementType'>,
): string {
  return action.text || action.label || action.name || action.elementType;
}

export type FieldTag = 'input' | 'select' | 'textarea';

export interface FormSummaryField {
  tag: FieldTag;
  /** type d'input (text, email, number, checkbox, radio…), ou la balise pour select/textarea. */
  type: string;
  name?: string;
  elementId?: string;
  label?: string;
  placeholder?: string;
  required: boolean;
  disabled: boolean;
  readOnly: boolean;
  min?: string;
  max?: string;
  step?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /** Libellés des options des éléments select (tronqués). */
  options?: string[];
}

export interface FormSummary {
  /** Index parmi les formulaires de la page ; -1 regroupe les champs qui ne sont dans aucun <form>. */
  index: number;
  name?: string;
  elementId?: string;
  /** URL d'action absolue, masquée. */
  action?: string;
  method: string;
  isSearchForm: boolean;
  submitLabel?: string;
  fields: FormSummaryField[];
}
