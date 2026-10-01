import type { FlowExpectation, FlowStep, FlowTarget } from '../config/flow-schema.js';
import type { FunctionalExchange } from '../functional/model.js';

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
  | 'control';

/** Un élément tel que le navigateur le décrit au moment de l'événement (jamais sa valeur). */
export interface RecordedElement {
  tag: string;
  role: string;
  /** Nom accessible (aria-label, libellé, texte du bouton…). */
  name: string;
  text?: string;
  label?: string;
  testId?: string;
  /** Attribut name. */
  nameAttr?: string;
  /** Angular formControlName (ou ng-reflect-name) : une preuve technique, pas un libellé. */
  formControlName?: string;
  elementId?: string;
  /** L'id semble généré (mat-input-23, :r1:, cdk-…) : jamais utilisé pour localiser. */
  generatedId?: boolean;
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
  /** dialog : alert / confirm / prompt, et ce que l'humain (ou la règle d'enregistrement) a répondu. */
  dialog?: { kind: string; accepted: boolean; message: string };
  /** checkpoint : libellé donné par l'humain. */
  label?: string;
  /** control : stop / pause / resume / checkpoint (depuis le bandeau). */
  control?: 'stop' | 'pause' | 'resume' | 'checkpoint';
  /** popup / download : URL de la nouvelle page, extension du fichier. */
  target?: string;
  /** Événement de bruit (clic de focus dans un champ…) : gardé dans la trace brute, ignoré ensuite. */
  noise?: string;
  /** L'observation de l'écran une fois l'action terminée (RecordedState.id), et les requêtes qu'elle a déclenchées. */
  stateAfter?: string;
  network?: FunctionalExchange[];
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
  | 'ASSERT';

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
  /** Libellé lisible (« Email », « Enregistrer »). */
  label: string;
  /** Les autres localisateurs possibles, du meilleur au moins bon. */
  alternatives: { target: FlowTarget; quality: LocatorQuality }[];
  ambiguous: boolean;
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
  invalidFields: number;
  dialogs: string[];
  /** Rôle + nom des contrôles visibles (pour savoir ce qui était atteignable). */
  controls: string[];
  /** Les lignes du plus grand tableau (une liste d'entités). */
  tableRows?: number;
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
  | 'AMBIGUOUS_RECORDED_TARGET'
  | 'FRAGILE_LOCATOR'
  | 'AMBIGUOUS_RECORDING_INTENT'
  | 'NEGATIVE_VALIDATION_FLOW'
  | 'SENSITIVE_VALUE_REDACTED'
  | 'BUFFER_OVERFLOW'
  | 'UNSUPPORTED_EVENT'
  | 'NO_OUTCOME_OBSERVED';

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
  /** Pourquoi cette étape (explicabilité du rapport). */
  explanation: string;
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
  | 'RAW_EVENT_CAPTURED'
  | 'SEMANTIC_ACTION_RESOLVED'
  | 'CHECKPOINT_ADDED'
  | 'RECORDING_PAUSED'
  | 'RECORDING_RESUMED'
  | 'RECORDING_STOPPED'
  | 'RECORDING_NORMALIZED'
  | 'OUTCOME_INFERRED'
  | 'FLOW_GENERATED'
  | 'REPLAY_VALIDATION_STARTED'
  | 'REPLAY_CONFIRMED'
  | 'REPLAY_FAILED'
  | 'RECORDING_COMPLETED'
  | 'RECORDING_FAILED';

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
