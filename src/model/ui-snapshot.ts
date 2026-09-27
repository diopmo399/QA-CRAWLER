import type { FormSummary } from './discovered-action.js';

/**
 * Faits sur un élément interactif, extraits du DOM par l'UIObserver. Données
 * simples : l'ActionDiscovery en fait une DiscoveredAction sans navigateur.
 */
export interface UiElement {
  /** Position parmi les éléments interactifs (débogage seulement ; jamais utilisée pour localiser). */
  index: number;
  tag: string;
  /** Rôle ARIA explicite ou implicite (button, link, tab, checkbox, combobox…), '' s'il n'y en a pas. */
  role: string;
  /** Nom accessible (aria-label, aria-labelledby, label, texte, title…). */
  name: string;
  /** Texte visible, espaces réduits. */
  text: string;
  /** Texte du <label> associé, pour les champs de formulaire. */
  label?: string;
  testId?: string;
  inputType?: string;
  /** Attribut name. */
  fieldName?: string;
  elementId?: string;
  /** URL absolue des liens. */
  href?: string;
  target?: string;
  routerLink?: string;
  autocomplete?: string;
  placeholder?: string;
  visible: boolean;
  disabled: boolean;
  readOnly: boolean;
  checked?: boolean;
  /** aria-selected (onglets, options). */
  selected?: boolean;
  /** aria-expanded (menus, accordéons). */
  expanded?: boolean;
  hasPopup: boolean;
  required: boolean;
  /** Envoie son formulaire. */
  isSubmit: boolean;
  /** Appartient à un formulaire de recherche/filtre (role=search, formulaire GET avec un champ de recherche). */
  inSearchForm: boolean;
  /** Index du <form> englobant, s'il y en a un. */
  formIndex?: number;
  /** Le formulaire englobant envoie vers une URL du serveur (attribut action). */
  formHasAction: boolean;
  /** Dans <nav>, role=navigation, menu ou tablist. */
  inNavigation: boolean;
  inDialog: boolean;
  /** Nom de la fenêtre englobante, s'il y en a une. */
  dialogName?: string;
  min?: string;
  max?: string;
  step?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /** Attribut inputmode (numeric, decimal, tel…) : le clavier que le champ attend. */
  inputMode?: string;
  /** Libellés des options désactivées d'un <select>. */
  disabledOptions?: string[];
  /** Libellés des options d'un <select> (les 30 premières). */
  options?: string[];
  /** L'élément visé par l'étape de flow imposé en cours. */
  flowTarget?: boolean;
  /** Formulaire auquel appartient l'élément : `form:<index>` pour un <form>, `layer:<nom>` pour une fenêtre/un calque. */
  formGroup?: string;
  /** Une liste qui n'est pas un <select> natif (role combobox/listbox : Angular Material…). */
  customSelect?: boolean;
  /** Zone contenteditable (texte riche, champ personnalisé) : remplie comme un champ texte. */
  editable?: boolean;
  /** Dessiné dans le shadow root d'un composant web. */
  inShadow?: boolean;
  /** Libellé deviné (texte voisin du champ, composant qui l'entoure) : Playwright ne le connaît pas. */
  labelGuessed?: boolean;
  /** Le champ contient déjà une valeur (la valeur elle-même n'est jamais lue). */
  hasValue?: boolean;
  /** Texte d'aide du champ (mat-hint, aria-describedby) : "99999", "HH:MM"… */
  hint?: string;
  /** Le champ ouvre un calendrier. */
  dateLike?: boolean;
  /** Libellé du groupe d'une radio / case à cocher (« Canal de contact »). */
  groupLabel?: string;
  /** Les radios d'un même choix partagent cette clé. */
  choiceGroup?: string;
  /** Dans un toast, une zone live ou un minuteur : va et vient, ne fait pas partie de l'identité de l'écran. */
  transient?: boolean;
  /** Devant l'écran : dans une fenêtre, un tiroir, un menu ouvert ou un calque. */
  foreground?: boolean;
  /** Derrière un calque modal (fond, aria-modal) : un clic tomberait sur le calque. */
  obscured?: boolean;
  /** Sélecteur CSS au mieux (localisateur de dernier recours). */
  css: string;
}

/** Vue structurée de l'écran courant — jamais le HTML brut. */
export interface UiSnapshot {
  url: string;
  title: string;
  /** Textes visibles h1–h3 / role=heading, dans l'ordre du document (12 au plus). */
  headings: string[];
  /** Noms accessibles des fenêtres visibles (modale, tiroir…). */
  dialogs: string[];
  /** Ce que l'écran dit de la dernière action (lu par l'UIOracle). */
  signals?: UiSignals;
  /** Nom du calque qui recouvre la page (modale, calque plein écran), s'il y en a un. */
  overlay?: string;
  /** Noms des onglets sélectionnés (aria-selected=true). */
  selectedTabs: string[];
  /** Éléments marqués aria-current (étape active, entrée de menu active). */
  currentItems: string[];
  /** Court extrait du texte visible (environ 600 caractères au plus), pour les humains et les futurs moteurs. */
  textExcerpt: string;
  elements: UiElement[];
  forms: FormSummary[];
  /** Faits de structure de l'écran (tableaux, fil d'Ariane, régions…), pour reconnaître les motifs d'interface. */
  structure?: PageStructure;
}

/**
 * Ce que l'écran contient, en nombres et en noms courts : jamais de données affichées
 * (les cellules des tableaux ne sont pas lues), seulement la forme de la page.
 */
export interface PageStructure {
  /** Tableaux de données visibles (<table>, role=table/grid, mat-table). */
  tables: number;
  /** Lignes de données du plus grand tableau (sans l'en-tête). */
  tableRows: number;
  /** En-têtes de colonnes du plus grand tableau (8 au plus). */
  columnHeaders: string[];
  /** Listes d'éléments répétés (role=list/listbox hors navigation, ul de cartes…) de 3 éléments ou plus. */
  lists: number;
  /** Cartes / tuiles (mat-card, .card, .tile, role=article). */
  cards: number;
  /** Fil d'Ariane (nav[aria-label*=breadcrumb], .breadcrumb). */
  breadcrumbs: string[];
  /** Noms des régions et repères nommés (role=region/main/navigation avec aria-label). */
  regions: string[];
  /** Étapes d'un assistant (mat-stepper, role=tablist d'étapes, .stepper, « Étape 2 sur 3 »). */
  wizardSteps: number;
  /** Champs d'envoi de fichier (input type=file, zone de dépôt). */
  fileInputs: number;
  /** Un message d'état vide est affiché (« Aucun résultat », « No data »…). */
  emptyMessage?: string;
  /** Une barre de pagination est visible (mat-paginator, nav[aria-label*=pagination], .pagination). */
  pagination: boolean;
}

/** Indices visibles de la façon dont une action s'est passée. */
export interface UiSignals {
  /** Textes des alertes, bannières d'erreur et snackbars visibles (5 au plus). */
  alerts: string[];
  /** Une roue de chargement, une barre de progression ou une zone aria-busy est visible. */
  busy: boolean;
  /** Rien à lire ni à faire à l'écran. */
  empty: boolean;
  /** Champs marqués aria-invalid. */
  invalidFields: number;
}
