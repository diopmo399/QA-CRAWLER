import type { TechnicalCategory, TechnicalIntent, TechnicalOperation } from './business/entity-classifier.js';
import type { PlaywrightTargetEvidence } from './sources/playwright-locator.js';
import type { CausalEffectCandidate } from './effect-causality.js';
import type {
  FlowExpectation,
  FlowStep,
  FlowTarget,
  StepEffects,
  TargetFingerprint,
} from '../config/flow-schema.js';
import type { FunctionalExchange } from '../functional/model.js';
import type { RecordingTargetValidation } from './target-validator.js';

/**
 * HUMAN FLOW RECORDER — le modèle. Trois représentations séparées, jamais écrasées :
 *
 *   RAW (RawRecordedEvent)        ce que le navigateur a vu, tel quel (sans aucune saisie en clair)
 *   SEMANTIC (SemanticRecordedAction)  ce que l'humain a fait, en intentions et cibles stables
 *   FINAL (RecordedFlow)          le flow nettoyé, avec ses résultats attendus
 *
 * Le RecordedFlow est la représentation intermédiaire UNIQUE d'où sortent le flow.yaml et
 * le .feature (par le SuggestedFlowGraph existant) : ils disent toujours la même chose.
 */

export type RecordingStatus = 'RECORDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export type RawEventType =
  | 'click'
  | 'input'
  | 'change'
  | 'submit'
  | 'keydown'
  | 'navigation'
  | 'dialog'
  | 'popup'
  | 'download'
  | 'filechooser'
  | 'checkpoint'
  | 'control'
  | 'drag';

/** Une zone de glisser-déposer telle qu'enregistrée : sa section et son libellé (jamais une position). */
export interface RecordedDropZone {
  section?: string;
  label?: string;
}

/**
 * Un GLISSER-DÉPOSER corrélé dans la page (appui → relâchement, ou dragstart → drop) : l'élément
 * (son texte), les zones d'origine et de destination, et ce qui a été observé après le dépôt.
 */
export interface RecordedDrag {
  kind: 'HTML5' | 'POINTER';
  item: string;
  source?: RecordedDropZone;
  destination?: RecordedDropZone;
  /** Déposé dans sa propre zone (un réordonnancement). */
  sameZone: boolean;
  /** ITEM_MOVED observé : l'élément est dans la destination et plus dans la source. */
  moved: boolean;
  /** Les listes avant / après (textes d'interface, bornés) : la preuve du déplacement. */
  lists?: {
    sourceBefore: string[];
    sourceAfter: string[];
    destinationAfter: string[];
    /** La zone d'arrivée telle qu'elle était au départ du glisser. */
    destinationBefore?: string[];
  };
  /** La zone d'arrivée parmi les zones candidates figées au départ (D1 = zone d'origine). */
  destinationCandidateId?: string;
}

/**
 * PRE-ACTION CONTEXT : l'écran tel que l'humain le voyait JUSTE AVANT son geste (capturé en phase
 * de capture, avant les gestionnaires de l'application). Jamais une valeur saisie : les listes
 * donnent leur choix affiché, les cases leur état, un champ texte rien.
 */
export interface PreActionContext {
  route: string;
  title: string;
  dialog?: string;
  headings: string[];
  /** Combien d'éléments le CSS enregistré trouvait avant l'action. */
  cssCount: number;
  /** Combien de contrôles visibles portaient le même texte. */
  sameText: number;
  /** Les choix déjà faits à l'écran (libellé → choix affiché). */
  selected: { label: string; value: string }[];
  activeTab?: string;
  /** Les éléments du même genre visibles à ce moment (candidats pré-action). */
  peers: { role: string; name: string; section?: string }[];
  /** Un indicateur de chargement était visible. */
  loading: boolean;
  /**
   * Les noms des contrôles et titres visibles au DÉBUT du geste (en minuscules). Ce que l'action
   * précédente a laissé : un contrôle absent ici est apparu APRÈS le début de ce geste.
   */
  controls?: string[];
  /** L'événement qui a figé la preuve : POINTERDOWN, FOCUSIN, BEFOREINPUT, KEYDOWN, DRAGSTART ; AT_EVENT = repli tardif. */
  phase?: string;
  /** Génération du DOM à la capture, puis à l'envoi (l'état AVANT l'action, voulu historique). */
  generation?: number;
  sentGeneration?: number;
  capturedAt?: number;
  /** originalTargetRuntimeId : relie événement brut → preuve pré-action → action → validation. */
  captureId?: string;
  /** La cible originale telle qu'elle était (sérialisable : jamais une référence au nœud). */
  target?: PreActionTargetSnapshot;
  /** Les candidats figés AVANT l'action ; la cible originale y est toujours (T1). */
  candidates?: PreActionCandidate[];
  originalCandidateId?: string;
  /** Glisser-déposer : les zones de dépôt visibles au départ (D1 = la zone d'origine). */
  dropZones?: PreActionDropZone[];
}

export interface PreActionDropZone {
  id: string;
  origin: 'SOURCE' | 'CONTEXT';
  section?: string;
  label?: string;
  itemCount: number;
}

/** Un candidat pré-action : une description, jamais un localisateur (le CSS n'est qu'un indice). */
export interface PreActionCandidate {
  id: string;
  origin: 'ORIGINAL_HUMAN_TARGET' | 'CONTEXT';
  relationship: 'SELF' | 'SAME_FORM' | 'SAME_DIALOG' | 'SAME_SECTION' | 'SAME_ROLE';
  tag: string;
  role: string;
  name: string;
  label?: string;
  text?: string;
  stableAttributes: Record<string, string>;
  visible: boolean;
  enabled: boolean;
  editable: boolean;
  /** L'hôte du composant (balise à tiret) qui porte la cible physique. */
  component?: string;
  form?: string;
  section?: string;
  dialog?: string;
  /** Le conteneur sémantique (mat-form-field, fieldset) de la cible physique. */
  container?: { tag: string; label?: string };
  nearby?: string[];
  cssHint?: string;
}

export interface PreActionTargetSnapshot extends PreActionCandidate {
  captureId: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  ariaDescription?: string;
}

/** Un élément tel que le navigateur le décrit au moment de l'événement (jamais sa valeur). */
export interface RecordedCssCandidate {
  selector: string;
  kind: string;
  matchCount: number;
  confidence: number;
  dynamic?: boolean;
  structural?: boolean;
}

export interface RecordedSelectors {
  preferred?: RecordedCssCandidate;
  structural: RecordedCssCandidate;
  candidates: RecordedCssCandidate[];
  ambiguity: { level: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH'; reasons: string[]; structuralMatches: number };
  /** L'analyse venait de l'inventaire de l'écran (INVENTORY) ou d'une analyse locale (LOCAL). */
  inventory: 'INVENTORY' | 'LOCAL';
}

/** Un élément interactif de l'inventaire d'un écran (jamais une valeur saisie). */
export interface ScreenInventoryElement {
  elementId: string;
  kind: string;
  tag: string;
  role?: string;
  label?: string;
  formControlName?: string;
  preferredCss?: string;
  preferredMatches?: number;
  confidence?: number;
  structuralCss?: string;
  structuralMatches?: number;
  ambiguity?: string;
  reasons?: string[];
  status: 'UNIQUE' | 'AMBIGUOUS';
}

/** SCREEN ELEMENT INVENTORY : les éléments interactifs d'un écran, connus AVANT les interactions. */
export interface ScreenInventory {
  at: number;
  url: string;
  screen?: string;
  reason: string;
  elements: number;
  durationMs: number;
  descriptors: ScreenInventoryElement[];
}

export interface RecordedElement {
  tag: string;
  role: string;
  /** Nom accessible (aria-label, libellé, texte du bouton…). */
  name: string;
  text?: string;
  label?: string;
  /** Champ sans libellé relié : le texte posé juste avant lui (deviné, inconnu de Playwright). */
  guessedLabel?: string;
  testId?: string;
  /** L'attribut qui porte le testId (data-testid, data-qa, data-cy…) : seul data-testid est lu par getByTestId. */
  testIdAttribute?: string;
  /** Attribut name. */
  nameAttr?: string;
  /** Angular formControlName (ou ng-reflect-name) : une preuve technique, pas un libellé. */
  formControlName?: string;
  elementId?: string;
  /** L'id semble généré (mat-input-23, :r1:, cdk-…) : jamais utilisé pour localiser. */
  generatedId?: boolean;
  /** Nombre d'éléments qui portent le MÊME id (> 1 : « #id » n'est pas une identité). */
  sameId?: number;
  /** Le champ fonctionnel qui contient l'élément (mat-form-field / fieldset / groupe) : son libellé. */
  formField?: string;
  /**
   * L'instance DOM, attribuée par l'enregistreur (e42) : deux événements du même nœud. Jamais un
   * localisateur de rejeu ; seulement une preuve d'identité pendant l'enregistrement.
   */
  domInstance?: string;
  /** La balise réellement touchée (un <span> dans un bouton) quand l'élément retenu est un ancêtre. */
  rawTag?: string;
  /**
   * PLAYWRIGHT, HYBRID : le localisateur que Playwright génère pour l'élément réellement touché, compté
   * dans la page au moment du geste (jamais un élément deviné).
   */
  playwright?: PlaywrightTargetEvidence & { mode: 'PLAYWRIGHT' | 'HYBRID' };
  /** Combien d'éléments le CSS enregistré désigne (> 1 : un localisateur générique, jamais une identité). */
  cssMatches?: number;
  /** Sa position parmi ces éléments (0 = premier) : le dernier recours, jamais une identité. */
  cssIndex?: number;
  /** Un CONTENEUR de plusieurs contrôles (en-tête d'onglets, barre d'outils) : leurs noms. */
  containerOf?: string[];
  /** formControlName lu sur le composant HÔTE (un input dans <app-input formcontrolname="x">). */
  formControlFromHost?: boolean;
  /** L'identité portée par l'ancêtre le plus proche (formControlName, data-testid, name, section…). */
  hostIdentity?: { tag: string; attribute: string; value: string; depth: number };
  /** DISCRIMINATING CSS : le préféré, le structurel (repli), les candidats comptés, l'ambiguïté. */
  selectors?: RecordedSelectors;
  /**
   * INTERACTION OWNER : le conteneur sémantique qui possède l'interaction (dialog, tab, accordion,
   * form, fieldset, card, row, menu, listbox, toolbar, section, component) et son nom.
   */
  ownerKind?: string;
  ownerName?: string;
  /** L'onglet qui commande le panneau de la cible, et s'il était sélectionné. */
  tab?: string;
  tabSelected?: boolean;
  /** Le panneau repliable (accordéon) de la cible, et s'il était ouvert. */
  accordion?: string;
  accordionExpanded?: boolean;
  /** Le formulaire (nom, aria-label, id stable). */
  form?: string;
  /** La clé de la ligne de tableau (première cellule). */
  row?: string;
  /**
   * L'IDENTITÉ DE LA LIGNE : la colonne (ou la paire) dont la valeur est unique parmi les lignes du
   * tableau (« Business key = 2935 ») — ce qui désigne la même ligne quel que soit l'ordre du tableau.
   */
  rowKey?: { column: string; value: string }[];
  /** Le contrôle qui ouvre la liste d'une option (« Operator »). */
  listboxOwner?: string;
  /** Le menu (nom ou déclencheur). */
  menu?: string;
  /** L'état d'une case / d'un radio AVANT l'action. */
  checked?: boolean;
  /** Le profil de saisie : longueur maximale, clavier (numeric…), motif. */
  maxLength?: number;
  inputMode?: string;
  pattern?: string;
  /** Le voisinage sémantique proche (libellés, titres, boutons) — jamais une valeur. */
  nearbyText?: string[];
  inputType?: string;
  autocomplete?: string;
  placeholder?: string;
  href?: string;
  /** Sélecteur CSS stable si possible ; sinon un chemin fragile (nth-of-type). */
  css: string;
  cssStable: boolean;
  inForm: boolean;
  isSubmit: boolean;
  inNavigation: boolean;
  inDialog: boolean;
  dialogName?: string;
  /** Libellé du groupe d'une radio / case à cocher. */
  groupLabel?: string;
  /** Combien d'éléments visibles portent le même rôle et le même nom, le même libellé, le même texte. */
  sameRoleName: number;
  sameLabel: number;
  /** Position parmi les éléments de même rôle et même nom (0 = premier). */
  roleNameIndex: number;
  contentEditable?: boolean;
  /** Liste déroulante personnalisée (role=combobox/listbox, mat-select). */
  customSelect?: boolean;
  required?: boolean;
  /** Champ en lecture seule (calculé par l'application) : jamais une donnée d'entrée. */
  readOnly?: boolean;
  /** Le titre de la section qui contient l'élément (contexte de l'empreinte). */
  context?: string;
  /** Le chemin de sections, de la plus large à la plus proche (« Colonnes > Colonnes disponibles »). */
  sectionPath?: string[];
  /** Champs de MÊME libellé dans la MÊME section (1 : unique dans sa section). */
  sameLabelInSection?: number;
  /** Le composant maison (balise à tiret) qui contient l'élément, à travers les shadow roots. */
  componentTag?: string;
  /** L'élément est dans un shadow DOM (son CSS est préfixé par l'hôte). */
  inShadow?: boolean;
  /** Un <select>, une liste de suggestions (datalist) : une valeur choisie, pas tapée. */
  hasOptions?: boolean;
}

/**
 * Ce que l'on sait d'une valeur sans la garder : sa forme, une empreinte salée (pour
 * comparer : corrections, valeur initiale), et pour un choix (option, case) son libellé.
 */
export interface RecordedValueFacts {
  empty: boolean;
  length: number;
  /** email, number, date, phone, url, code (CAPITALES_SOULIGNÉES), text. */
  shape: 'email' | 'number' | 'date' | 'phone' | 'url' | 'code' | 'text' | 'empty';
  /** Empreinte salée par session (jamais pour un champ sensible). */
  digest?: string;
  /** Empreinte de la valeur PLIÉE (casse, espaces, accents) : reconnaît une transformation UI → API. */
  foldedDigest?: string;
  /** La valeur contient au moins un chiffre (jamais pour un champ sensible) : un nom n'est pas un identifiant. */
  hasDigit?: boolean;
  /** Empreinte de la valeur trouvée quand l'humain est entré dans le champ. */
  initialDigest?: string;
  /** Le navigateur juge le champ sensible (mot de passe, code à usage unique, carte…). */
  sensitive?: boolean;
  /** <select> / option choisie : libellé visible et code. */
  option?: { label: string; value?: string };
  checked?: boolean;
  /** Fichiers choisis : extensions seulement, jamais le chemin. */
  files?: string[];
  /** Début de la saisie (ms) : la place de l'étape dans le flow. */
  startedAt?: number;
}

export interface RawRecordedEvent {
  id: string;
  sequence: number;
  type: RawEventType;
  /** Horodatage (ms) de l'événement. */
  at: number;
  url: string;
  element?: RecordedElement;
  value?: RecordedValueFacts;
  /** keydown : la touche (Enter, Escape, Tab seulement). */
  key?: string;
  /** HYBRID : le geste vu par les deux sources (une seule action), et l'observation de l'autre source. */
  sources?: ('current' | 'playwright')[];
  correlatedWith?: string;
  /** drag : le glisser-déposer corrélé (élément, zones, déplacement observé). */
  drag?: RecordedDrag;
  /** L'écran juste AVANT l'action (pour valider une cible que l'action fait disparaître). */
  pre?: PreActionContext;
  /** input / change : l'instance DOM de l'élément actif à ce moment (document.activeElement). */
  activeDomInstance?: string;
  /** AUTO-VALIDATION immédiate de la cible (recherche à sec, jamais rejouée). */
  targetValidation?: RecordingTargetValidation;
  /** dialog : alert / confirm / prompt, et ce que l'humain (ou la règle d'enregistrement) a répondu. */
  dialog?: { kind: string; accepted: boolean; message: string };
  /** checkpoint : libellé donné par l'humain. */
  label?: string;
  /** control : stop / pause / resume / checkpoint / dock (depuis le bandeau). */
  control?: 'stop' | 'pause' | 'resume' | 'checkpoint' | 'undo' | 'dock';
  /** control dock : où l'humain a rangé le bandeau (un coin), réduit ou non. */
  dock?: OverlayDock;
  /** popup / download : URL de la nouvelle page, extension du fichier. */
  target?: string;
  /** navigation : type de transition du navigateur (link, typed, reload, form_submit…, forward_back). */
  transition?: string;
  /** Événement de bruit (clic de focus dans un champ…) : gardé dans la trace brute, ignoré ensuite. */
  noise?: string;
  /** L'observation de l'écran une fois l'action terminée (RecordedState.id), et les requêtes qu'elle a déclenchées. */
  stateAfter?: string;
  /** L'observation de cette action a été fermée par l'action humaine suivante (frontière causale). */
  observationClosedBy?: string;
  /** L'observation (unique) qui a donné stateAfter : des actions de la MÊME observation partagent un écran. */
  observationId?: string;
  network?: FunctionalExchange[];
  /** ANNULÉ par l'humain (↶ Annuler) : gardé dans la trace brute, jamais dans le flow. */
  undone?: boolean;
  /** L'humain a confirmé l'élément touché d'une action ambiguë (son rang parmi les correspondances). */
  userResolution?: { candidateIndex: number; at: number };
  /** L'humain a choisi de laisser l'ambiguïté (elle reste signalée). */
  ambiguityIgnored?: boolean;
}

export type SemanticActionType =
  | 'NAVIGATE'
  | 'CLICK'
  | 'FILL'
  | 'SELECT'
  | 'CHECK'
  | 'UNCHECK'
  | 'SUBMIT'
  | 'CONFIRM'
  | 'CANCEL'
  | 'UPLOAD'
  | 'WAIT_FOR'
  | 'ASSERT'
  | 'DRAG_AND_DROP';

export type LocatorQuality =
  'SEMANTIC' | 'ACCESSIBLE' | 'STABLE_ATTRIBUTE' | 'FRAMEWORK_BINDING' | 'CSS_STABLE' | 'FRAGILE';

export type ValueClass =
  | 'GENERATED_TEST_DATA'
  | 'LITERAL_BUSINESS_VALUE'
  | 'SENSITIVE_REFERENCE'
  | 'PREEXISTING_VALUE'
  | 'DERIVED_VALUE'
  | 'UNKNOWN';

export type RecordedProvenance =
  | 'HUMAN_RECORDED'
  | 'NORMALIZED_FROM_HUMAN'
  | 'INFERRED_OUTCOME'
  | 'MANUAL_CHECKPOINT'
  | 'STATIC_ENRICHED'
  | 'RUNTIME_OBSERVED';

/** Une cible choisie pour le rejeu, et pourquoi. */
export interface RecordedTarget {
  target: FlowTarget;
  quality: LocatorQuality;
  /** L'empreinte de l'élément (rôle, nom, texte, test id, balise, section) : vérifiée avant de cliquer au rejeu. */
  fingerprint?: TargetFingerprint;
  /** Libellé lisible (« Email », « Enregistrer »). */
  label: string;
  /** Les autres localisateurs possibles, du meilleur au moins bon. */
  alternatives: { target: FlowTarget; quality: LocatorQuality }[];
  ambiguous: boolean;
  /**
   * Le libellé vient d'un nom réel (libellé, nom accessible, texte, placeholder, attribut) et pas
   * du type de l'élément : sans nom, aucune intention ne peut être dite (« input » ne désigne rien).
   */
  named: boolean;
  reasons: string[];
}

/** La valeur d'une action, sans la saisie elle-même. */
export interface RecordedValue {
  class: ValueClass;
  /** testData : la clé (email, firstName…) ; env : la variable ; literal : la valeur (choix, code). */
  testData?: string;
  env?: string;
  literal?: string;
  sensitive: boolean;
  reason: string;
}

/** Un écran observé après une action (UIObserver → StateDetector). */
export interface RecordedState {
  /** Id de l'observation (o1, o2…) : le même écran peut être observé plusieurs fois (un message en plus). */
  id: string;
  /** L'écran (StateDetector) : le nœud de la carte des flows. */
  stateId: string;
  label: string;
  route: string;
  url: string;
  title: string;
  headings: string[];
  alerts: string[];
  /** Messages de statut (role="status") : la confirmation d'une création, sans être une alerte. */
  statuses?: string[];
  /** Les conteneurs applicatifs visibles (éléments personnalisés de grande taille) : indices de contexte. */
  hosts?: string[];
  /** Les cadres visibles (iframe : origine + chemin) : un micro-frontend peut y vivre. */
  frames?: string[];
  invalidFields: number;
  dialogs: string[];
  /** Rôle + nom des contrôles visibles (pour savoir ce qui était atteignable). */
  controls: string[];
  /** Les lignes du plus grand tableau (une liste d'entités). */
  tableRows?: number;
  /** Quand l'écran a été observé (horloge de l'enregistreur) : la chronologie, pas une preuve de cause. */
  observedAt?: number;
}

export interface SemanticRecordedAction {
  id: string;
  type: SemanticActionType;
  /** Événements bruts d'où vient l'action. */
  rawEventIds: string[];
  at: number;
  url: string;
  target?: RecordedTarget;
  value?: RecordedValue;
  /** SELECT : option choisie (libellé visible). */
  option?: string;
  /** NAVIGATE : la route (sans hôte). */
  route?: string;
  /** Classement de la SafetyPolicy pour le rejeu (SAFE, MUTATION…). */
  classification?: 'SAFE' | 'MUTATION' | 'DANGEROUS' | 'UNKNOWN';
  /** État avant / après (StateDetector). */
  stateBefore?: string;
  stateAfter?: string;
  /** Requêtes déclenchées par l'action (forme seulement). */
  network: FunctionalExchange[];
  provenance: RecordedProvenance;
  confidence: number;
  evidence: string[];
  /** Raison pour laquelle le normaliseur l'a écartée (jamais supprimée de la trace). */
  dropped?: string;
  /** Raison de fusion (saisies successives, corrections…). */
  merged?: string;
  /** Un point de contrôle posé juste après cette action. */
  checkpoint?: string;
  /** Effets hors de la page : nouvelle fenêtre, téléchargement (extension seulement). */
  sideEffects?: string[];
  /** CONFIRM / CANCEL : le dialogue du navigateur (type, message court). */
  dialog?: { kind: string; message: string };
  /**
   * La navigation que l'action a causée (ACTION CORRELATION) : un EFFET, pas une étape. Routes
   * dans l'ordre (redirections comprises), confiance et raisons de la corrélation.
   */
  navigation?: {
    routes: string[];
    navigationIds: string[];
    confidence: string;
    score: number;
    reasons: string[];
    provenance: 'RUNTIME_OBSERVED';
  };
  /** NAVIGATE gardé comme étape goto : pourquoi aucune action humaine ne l'explique. */
  gotoReason?: string;
  /** UNRESOLVED : un contrôle cliqué par l'humain dont l'intention n'est pas (encore) comprise — gardé. */
  semanticStatus?: 'RESOLVED' | 'UNRESOLVED';
  /** Ce que l'action a changé à l'écran (section révélée, champ ajouté, fenêtre ouverte…), même sans requête. */
  domEffects?: string[];
  /** Les effets attendus au rejeu, appris de l'enregistrement (contrôles apparus, route, requête). */
  expectedEffects?: StepEffects;
  /** Les effets candidats et leur attribution causale (retenus, facultatifs, écartés). */
  effectCausality?: CausalEffectCandidate[];
  /** L'écran au début du geste (pre.controls) : la preuve de ce qui existait AVANT cette action. */
  preActionControls?: string[];
  preActionRoute?: string;
  /** L'observation de cette action a été fermée par l'action humaine suivante. */
  observationClosedBy?: string;
  /** L'observation qui a donné stateAfter (unique par observation). */
  observationId?: string;
  /** DRAG_AND_DROP : l'élément, ses zones, et l'effet ITEM_MOVED observé à l'enregistrement. */
  drag?: RecordedDrag;
  /** La validation immédiate de sa cible (statut, tentatives, réparation, audit). */
  targetValidation?: RecordingTargetValidation;
  /** Un groupe sémantique (FILTER_CONFIGURATION : champ, opérateur, valeur) : le contexte de la cible. */
  semanticGroup?: { kind: string; id: string; context: Record<string, string> };
}

export type AssertionKind =
  | 'ROUTE'
  | 'ENTITY_EXISTS'
  | 'BUSINESS_STATE'
  | 'FIELD_STATE'
  | 'MESSAGE'
  | 'API_OUTCOME'
  | 'RULE'
  | 'INVARIANT'
  | 'SIDE_EFFECT';

/** Une vérification proposée : stable (rejouable telle quelle) ou fragile (pour revue). */
export interface AssertionCandidate {
  id: string;
  kind: AssertionKind;
  description: string;
  expect?: FlowExpectation;
  stability: 'STABLE' | 'LIKELY_STABLE' | 'FRAGILE';
  confidence: number;
  /** Action après laquelle la vérification s'applique. */
  afterActionId: string;
  provenance: RecordedProvenance;
  evidence: string[];
  /** Retenue dans le flow généré (stable et assez sûre). */
  selected: boolean;
  reason: string;
}

export interface RecordedCheckpoint {
  id: string;
  label: string;
  at: number;
  afterActionId?: string;
  state?: RecordedState;
  assertions: string[];
}

export type RecordingWarningCode =
  /** Plusieurs saisies de champs différents dans une seule action FILL (FIELD IDENTITY). */
  | 'INVALID_FIELD_MERGE'
  | 'POSSIBLY_INVALID_FIELD_MERGE'
  | 'GENERIC_TEST_DATA_KEY'
  | 'AMBIGUOUS_RECORDED_TARGET'
  | 'FRAGILE_LOCATOR'
  | 'AMBIGUOUS_RECORDING_INTENT'
  | 'NEGATIVE_VALIDATION_FLOW'
  | 'SENSITIVE_VALUE_REDACTED'
  | 'BUFFER_OVERFLOW'
  | 'SUSPICIOUS_NAVIGATION_COLLAPSE'
  | 'SEMANTIC_ACTION_LOST'
  | 'CAUSALITY_AMBIGUOUS'
  | 'TEST_DATA_COLLISION'
  | 'FLOW_GENERATION_LOST_HUMAN_ACTIONS'
  | 'UNSUPPORTED_EVENT'
  | 'NO_OUTCOME_OBSERVED'
  /** Des actions retirées par l'humain (↶ Annuler) : exclues du flow, gardées dans la trace brute. */
  | 'USER_UNDONE_ACTIONS';

export interface RecordingWarning {
  code: RecordingWarningCode;
  message: string;
  actionId?: string;
}

/** Ce que l'enregistrement a compris du métier (workflow, entité, transitions). */
export interface RecordedIntent {
  /** CREATE:USER… (verbe:entité), d'après l'écriture acceptée. */
  workflow?: string;
  entity?: string;
  api?: string;
  transitions: { entity: string; from: string; to: string }[];
  confidence: number;
  evidence: string[];
  /**
   * Les INTENTS TECHNIQUES (authentification, découverte, santé, configuration…) : observés, séparés
   * de l'intent métier (workflow), et jamais interprétés comme une création métier.
   */
  technical?: TechnicalIntentRecord[];
}

export interface TechnicalIntentRecord {
  intent: TechnicalIntent;
  operation: TechnicalOperation;
  category: TechnicalCategory;
  classification: 'TECHNICAL_ENTITY' | 'INFRASTRUCTURE_ENTITY';
  /** Méthode + gabarit d'URL (identifiants remplacés). */
  api: string;
  status?: number;
  actionIds: string[];
  reason: string;
}

/** Une étape du flow final : l'étape exécutable + d'où elle vient. */
export interface RecordedFlowStep {
  id: string;
  step: FlowStep;
  label: string;
  /** Actions sémantiques d'où vient l'étape. */
  actionIds: string[];
  rawEventIds: string[];
  provenance: RecordedProvenance;
  confidence: number;
  quality?: LocatorQuality;
  valueClass?: ValueClass;
  /** Les interactions humaines (h001…) que l'étape représente. */
  interactionIds?: string[];
  /** UNRESOLVED_HUMAN_ACTION : gardée bien que son intention ne soit pas comprise. */
  semanticStatus?: 'RESOLVED' | 'UNRESOLVED';
  /** La validation immédiate de sa cible ; une cible non prouvée reste, à confirmer au rejeu. */
  targetValidation?: { status: string; repaired: boolean; requiresReplayValidation: boolean };
  /** Pourquoi cette étape (explicabilité du rapport). */
  explanation: string;
  /** Une ambiguïté tranchée par l'humain (élément touché confirmé) ou laissée par lui (à vérifier au rejeu). */
  userDecision?: 'AMBIGUITY_CONFIRMED_BY_USER' | 'AMBIGUITY_LEFT_BY_USER';
}

/** LA représentation intermédiaire : la seule source du YAML et du Gherkin. */
export interface RecordedFlow {
  name: string;
  recordingSessionId: string;
  startAt: string;
  steps: RecordedFlowStep[];
  assertions: AssertionCandidate[];
  intent: RecordedIntent;
  /** Un enregistrement d'erreur de validation voulu (point de contrôle sur l'erreur). */
  negative: boolean;
  quality: RecordingQuality;
}

/** La qualité, exposée sans note globale : des faits, à juger par l'humain. */
export interface RecordingQuality {
  steps: number;
  locators: Record<LocatorQuality, number>;
  ambiguousTargets: number;
  fragileLocators: number;
  values: Record<ValueClass, number>;
  assertions: { stable: number; selected: number; fragile: number };
  removedNoise: number;
  mergedInputs: number;
  collapsedCorrections: number;
  removedDetours: number;
  sensitiveRedacted: number;
}

export interface RecordingSession {
  id: string;
  name: string;
  startedAt: string;
  endedAt?: string;
  startUrl: string;
  version?: string;
  environment?: string;
  role?: string;
  status: RecordingStatus;
  rawEvents: RawRecordedEvent[];
  semanticActions: SemanticRecordedAction[];
  checkpoints: RecordedCheckpoint[];
  /** Écrans observés, dans l'ordre ; le premier est l'écran de départ. */
  states: RecordedState[];
  initialStateId?: string;
  warnings: RecordingWarning[];
  /** Événements écartés faute de place (le tampon est borné). */
  droppedEvents: number;
}

export type RecordingEventType =
  | 'RECORDING_STARTED'
  | 'RECORDING_ACTION_WINDOW_OPENED'
  | 'RECORDING_ACTION_WINDOW_CLOSED'
  | 'EFFECT_CAUSALITY_EVALUATED'
  | 'EFFECT_ASSIGNED_TO_ACTION'
  | 'EFFECT_REJECTED_FROM_ACTION'
  | 'EFFECT_REASSIGNED'
  | 'EFFECT_MARKED_OPTIONAL'
  | 'RECORDING_EFFECT_CONTAMINATION_DETECTED'
  | 'RECORDING_CONSISTENCY_VALIDATED'
  | 'RAW_EVENT_CAPTURED'
  /** QA_DEBUG : la trace déterministe du recorder ([RECORDER] RAW EVENT / ELEMENT / VALIDATION / RECORDED / EVENT IGNORED). */
  | 'RECORDER_DEBUG'
  /** L'analyse HTTP : une passe en direct (provisoire), puis la consolidation après l'arrêt. */
  | 'HTTP_ANALYSIS_UPDATED'
  | 'HTTP_ANALYSIS_CONSOLIDATED'
  | 'RECORDING_SOURCE'
  | 'BUSINESS_FLOW_DETECTED'
  | 'APPLICATION_MODEL_BUILT'
  /** La timeline en direct (une action ajoutée, validée, annulée, résolue). */
  | 'LIVE_ACTION_UPDATED'
  | 'ACTION_UNDONE'
  | 'AMBIGUITY_RESOLVED'
  | 'AMBIGUITY_IGNORED'
  | 'RECORDING_SAVED'
  | 'RECORDING_STEP_REMOVED'
  | 'RECORDING_INTENT_REVIEWED'
  | 'SEMANTIC_ACTION_RESOLVED'
  | 'CHECKPOINT_ADDED'
  | 'RECORDING_PAUSED'
  | 'RECORDING_RESUMED'
  | 'RECORDING_STOPPED'
  /** L'arrêt en cours : ce qui reste à finir (validations en file, dernière observation…). */
  | 'RECORDING_STOPPING'
  /** Le temps de chaque phase après « Stop » (validations, traitement, IA, rejeu, écriture). */
  | 'RECORDING_STOP_TIMING'
  | 'RECORDING_NORMALIZED'
  | 'OUTCOME_INFERRED'
  | 'FLOW_GENERATED'
  | 'REPLAY_VALIDATION_STARTED'
  | 'REPLAY_CONFIRMED'
  | 'REPLAY_FAILED'
  | 'RECORDING_COMPLETED'
  | 'RECORDING_ENRICHED'
  | 'RECORDING_SEMANTIC_AUDITED'
  | 'RECORDING_FLOW_AUDITED'
  | 'TARGET_VALIDATION'
  | 'RECORDING_FAILED'
  | 'ACTION_CORRELATION_STARTED'
  | 'ACTION_EFFECT_CORRELATED'
  | 'NAVIGATION_CORRELATED_TO_ACTION'
  | 'NAVIGATION_UNCORRELATED'
  | 'GOTO_FALLBACK_GENERATED'
  | 'CAUSALITY_AMBIGUOUS'
  | 'SUSPICIOUS_NAVIGATION_COLLAPSE'
  | 'FLOW_SEMANTIC_PRESERVATION_CHECK'
  | 'RECORDED_TEST_DATA_DISCOVERED'
  | 'TEST_DATA_KEY_RESOLVED'
  | 'TEST_DATA_CLASSIFIED'
  | 'TEST_DATA_GENERALIZED'
  | 'TEST_DATA_LITERAL_PRESERVED'
  | 'TEST_DATA_REFERENCE_CREATED'
  | 'TEST_DATA_GENERATED_FOR_RUN'
  | 'SENSITIVE_RECORDED_VALUE_REDACTED'
  | 'TEST_DATA_COLLISION_DETECTED'
  | 'TEST_DATA_STRATEGY_CANDIDATE'
  | 'HUMAN_INTERACTION_CAPTURED'
  | 'HUMAN_INTERACTION_PRESERVED'
  | 'HUMAN_INTERACTION_MERGED'
  | 'HUMAN_INTERACTION_EXCLUDED'
  | 'HUMAN_INTERACTION_UNRESOLVED'
  | 'HUMAN_ACTION_DEPENDENCY_DISCOVERED'
  | 'HUMAN_JOURNEY_BUILT'
  | 'HUMAN_JOURNEY_VALIDATION_STARTED'
  | 'HUMAN_JOURNEY_VALIDATION_FAILED'
  | 'HUMAN_JOURNEY_VALIDATED'
  | 'HUMAN_ACTION_LOST'
  | 'FLOW_OPTIMIZATION_STARTED'
  | 'FLOW_OPTIMIZATION_COMPLETED'
  /** FIELD IDENTITY : l'identité fonctionnelle d'un champ et les décisions de fusion de saisies. */
  | 'FIELD_IDENTITY_CREATED'
  | 'FIELD_IDENTITY_MATCHED'
  | 'FIELD_IDENTITY_MISMATCH'
  | 'FIELD_IDENTITY_AMBIGUOUS'
  | 'TYPING_MERGE_EVALUATED'
  | 'TYPING_MERGE_ACCEPTED'
  | 'TYPING_MERGE_REJECTED'
  | 'GENERIC_LOCATOR_DETECTED'
  | 'NON_UNIQUE_FIELD_LOCATOR'
  | 'TESTDATA_FIELD_BOUND'
  | 'TESTDATA_FIELD_CONFLICT'
  /** DISCRIMINATING SELECTORS : inventaire d'écran, candidats CSS, actions dupliquées. */
  | 'SCREEN_INVENTORY_COMPLETED'
  | 'TARGET_MATCHED_FROM_INVENTORY'
  | 'TARGET_INVENTORY_MISS'
  | 'LOCATOR_AMBIGUOUS'
  | 'CSS_CANDIDATE_SELECTED'
  | 'DUPLICATE_TARGET_ACTION_DETECTED';

export interface RecordingEvent {
  type: RecordingEventType;
  at: string;
  message: string;
  data?: Record<string, unknown>;
}

export function emptyQuality(): RecordingQuality {
  return {
    steps: 0,
    locators: {
      SEMANTIC: 0,
      ACCESSIBLE: 0,
      STABLE_ATTRIBUTE: 0,
      FRAMEWORK_BINDING: 0,
      CSS_STABLE: 0,
      FRAGILE: 0,
    },
    ambiguousTargets: 0,
    fragileLocators: 0,
    values: {
      GENERATED_TEST_DATA: 0,
      LITERAL_BUSINESS_VALUE: 0,
      SENSITIVE_REFERENCE: 0,
      PREEXISTING_VALUE: 0,
      DERIVED_VALUE: 0,
      UNKNOWN: 0,
    },
    assertions: { stable: 0, selected: 0, fragile: 0 },
    removedNoise: 0,
    mergedInputs: 0,
    collapsedCorrections: 0,
    removedDetours: 0,
    sensitiveRedacted: 0,
  };
}

/** La place du bandeau d'enregistrement dans la page : un coin, réduit ou non. */
export interface OverlayDock {
  corner: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  minimized: boolean;
}
