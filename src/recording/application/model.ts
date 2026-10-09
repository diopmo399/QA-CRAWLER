import type { StateCode } from '../../functional/model.js';
import type { EntityClassification } from '../business/entity-classifier.js';
import type { EntityProvenance } from '../business/provenance-resolver.js';

/**
 * APPLICATION INTERACTION MODEL : ce que le Recorder a compris de l'APPLICATION (pas seulement des
 * clics) — contextes (shell, espace de travail, micro-frontends), collections lues, tasks,
 * entités, identités, relations, actions métier. Générique : aucun nom de domaine, de route ou
 * d'API n'est une règle. Toute interprétation garde ses preuves (evidenceIds) et les actions
 * techniques d'origine (actionIds) : le flow Playwright reste la vérité exécutable.
 */

/**
 * OBSERVED   vu tel quel (un changement de contexte, un enregistrement lu, une valeur affichée)
 * DEDUCED    inféré par une règle déterministe à partir d'observations
 * CONFIRMED  ≥ 0,85 avec plusieurs preuves concordantes
 * UNCERTAIN  < 0,6, ou plusieurs cibles possibles : jamais une vérité
 */
export type InterpretationStatus = 'OBSERVED' | 'DEDUCED' | 'CONFIRMED' | 'UNCERTAIN';

export interface InteractionEvidence {
  id: string;
  source: 'DOM' | 'NETWORK' | 'NAVIGATION' | 'USER_ACTION' | 'FRAME' | 'ENTITY_EVIDENCE';
  description: string;
  actionIds: string[];
  rawEventIds: string[];
  stateIds: string[];
  /** Une preuve de la couche entité (business/entity-evidence.ts) qu'elle reprend. */
  ref?: string;
}

/** Une identité possible, typée par sa FORME et le nom de son champ (des indices, jamais des règles). */
export type IdentityType =
  | 'TASK_ID'
  | 'ENTITY_ID'
  | 'ID'
  | 'UUID'
  | 'BUSINESS_KEY'
  | 'REFERENCE'
  | 'CODE'
  | 'FOREIGN_ID'
  | 'ROUTE_SEGMENT'
  | 'DISPLAYED_VALUE';

export interface IdentityCandidate {
  type: IdentityType;
  /** Le champ qui la portait (taskId, businessKey, (path)…) : un indice, jamais une règle. */
  field?: string;
  /** Seulement si l'application l'a montrée et qu'elle a la forme d'un identifiant. */
  value?: string;
  digest?: string;
  source: 'NETWORK_RESPONSE' | 'NETWORK_PATH' | 'DOM' | 'ROUTE' | 'USER_INPUT';
  confidence: number;
  /** Les preuves qui portent cette identité. */
  evidenceIds?: string[];
}

/** Un contexte applicatif : un écran du shell, un espace de travail, un micro-frontend. */
export interface ApplicationContext {
  key: string;
  /**
   * Un contexte de l'application (shell, espace de travail, micro-frontend) — ou TECHNIQUE (écran
   * d'authentification, de configuration) : jamais une entité métier.
   */
  classification: 'APPLICATION_CONTEXT' | 'TECHNICAL_CONTEXT';
  /** D'où vient la signature : un cadre (iframe), un élément personnalisé hôte, une route. */
  kind: 'FRAME' | 'HOST' | 'ROUTE';
  name: string;
  /** SHELL (toujours là), WORKSPACE (héberge une liste de tasks), MICROFRONTEND (ouvert depuis un autre contexte). */
  role?: 'WORKSPACE' | 'MICROFRONTEND';
  routes: string[];
  origin?: string;
  frame?: string;
  hosts: string[];
  stateIds: string[];
  actionIds: string[];
  evidenceIds: string[];
}

/** Une collection d'enregistrements identifiables : lue (réseau) ou affichée (lignes du DOM). */
export interface WorkCollection {
  key: string;
  source: { type: 'NETWORK'; method: string; path: string } | { type: 'DOM' };
  records: CollectionRecord[];
  /** Le contexte où elle est affichée (l'écran après la lecture). */
  contextKey?: string;
  /** Chaque lecture : l'action qui l'a déclenchée, et sa place dans le parcours. */
  observations: { actionId: string; actionIndex: number; recordCount: number; evidenceId: string }[];
  /** La liste a été lue juste après une recherche saisie (des résultats, pas des tasks). */
  searchResults: boolean;
}

export interface CollectionRecord {
  index: number;
  identityCandidates: IdentityCandidate[];
  state?: StateCode;
}

export interface TaskWorkspace {
  key: string;
  type: 'TASK_WORKSPACE';
  classification: 'APPLICATION_ENTITY';
  contextKey?: string;
  collectionKey: string;
  source:
    | {
        type: 'NETWORK';
        path: string;
        /** Un BFF n'est jamais supposé : les raisons qui en font un candidat. */
        bffCandidate?: { confidence: number; reasons: string[] };
      }
    | { type: 'DOM' };
  taskKeys: string[];
  confidence: number;
  status: InterpretationStatus;
  reason: string;
  evidenceIds: string[];
}

export interface Task {
  key: string;
  /** Une task est un objet de l'APPLICATION : elle peut référencer une entité métier, jamais l'être. */
  classification: 'APPLICATION_ENTITY';
  workspaceKey: string;
  /** taskId ≠ businessKey : chaque identité possible, typée. */
  identityCandidates: IdentityCandidate[];
  primary: IdentityCandidate;
  /** Les sélections de la task par l'humain. */
  selectedBy: string[];
  confidence: number;
  status: InterpretationStatus;
  reason: string;
  evidenceIds: string[];
}

export type RelationshipType =
  | 'CONTAINS'
  | 'DISPLAYS'
  | 'REFERENCES'
  | 'RETRIEVED_BY'
  | 'CREATED_BY'
  | 'OPENED_BY'
  | 'SEARCHED_BY'
  | 'UPDATED_BY'
  | 'NAVIGATES_TO'
  | 'CORRELATES_WITH'
  | 'RESULTS_IN'
  | 'DERIVED_FROM'
  | 'CREATE_RESULT';

export interface Relationship {
  id: string;
  /** Extensible : un type inconnu reste une chaîne. */
  type: RelationshipType | (string & {});
  source: string;
  target: string;
  confidence: number;
  status: InterpretationStatus;
  reason: string;
  evidenceIds: string[];
  actionIds: string[];
  /** UNCERTAIN : les cibles possibles (jamais un choix arbitraire). */
  candidates?: string[];
  analyzer: 'DETERMINISTIC' | 'AI_PROPOSAL';
}

export type BusinessActionKind =
  | 'SELECT_TASK'
  | 'SWITCH_CONTEXT'
  | 'NAVIGATE'
  | 'CREATE'
  | 'SEARCH'
  | 'OPEN'
  | 'RETRIEVE'
  | 'UPDATE'
  | 'SAVE'
  | 'DELETE'
  | 'SUBMIT';

export interface BusinessAction {
  id: string;
  kind: BusinessActionKind;
  /** La task, l'entité ou le contexte concerné. */
  subject?: string;
  /** Le contexte où l'action a eu lieu. */
  contextKey?: string;
  /** Les actions Playwright d'origine (a3…) et les étapes du flow (s4…). */
  actionIds: string[];
  stepIds: string[];
  confidence: number;
  status: InterpretationStatus;
  reason: string;
  evidenceIds: string[];
}

export interface ModelEntity {
  key: string;
  type: string;
  /** BUSINESS_ENTITY ou UNKNOWN (le technique et l'infrastructure vont dans technicalContext). */
  classification: {
    classification: EntityClassification;
    confidence: number;
    reason: string;
    signals: string[];
    analyzer: 'DETERMINISTIC' | 'AI_PROPOSAL';
  };
  identity: IdentityCandidate;
  identityCandidates: IdentityCandidate[];
  provenance: { classification: EntityProvenance; confidence: number; reason: string };
  lifecycle: string[];
  firstSeen: { actionId?: string; actionIndex: number };
  lastSeen: { actionId?: string; actionIndex: number };
  tasks: string[];
  contexts: string[];
  relationships: string[];
}

/** Un élément technique ou d'infrastructure : gardé comme observation, jamais dans le flow métier. */
export interface TechnicalItem {
  key: string;
  classification: 'TECHNICAL_ENTITY' | 'INFRASTRUCTURE_ENTITY';
  category:
    | 'AUTHENTICATION'
    | 'DISCOVERY'
    | 'HEALTH_TELEMETRY'
    | 'STATIC_RESOURCE'
    | 'CONFIGURATION'
    | 'COMPONENT'
    | 'OTHER';
  label: string;
  /** D'où vient l'observation : une entité suivie reclassée, un appel réseau, une navigation, le DOM. */
  source: 'ENTITY' | 'NETWORK' | 'NAVIGATION' | 'DOM';
  confidence: number;
  reason: string;
  evidenceIds: string[];
  actionIds: string[];
}

/**
 * Les TROIS niveaux d'une action, indépendants : ENREGISTRÉE (toujours, jamais retirée), VALIDÉE
 * (la cible Playwright a été vérifiée), INTERPRÉTÉE (une action métier l'explique, sinon UNKNOWN).
 */
export interface ActionView {
  actionId: string;
  type: string;
  label?: string;
  stepIds: string[];
  recorded: true;
  validation: 'VALIDATED' | 'AMBIGUOUS' | 'FAILED' | 'UNVERIFIED';
  /** Le statut détaillé du validateur (VALIDATED_PRE_ACTION, NOT_FOUND…). */
  validationStatus?: string;
  interpretation: (BusinessActionKind | 'UNKNOWN')[];
}

export interface ApplicationInteractionModel {
  version: 1;
  application: { origin?: string; startRoute?: string; shell: string[] };
  contexts: ApplicationContext[];
  collections: WorkCollection[];
  workspaces: TaskWorkspace[];
  tasks: Task[];
  /** Les entités MÉTIER (et celles encore inconnues) : le Business Context. */
  entities: ModelEntity[];
  businessContext: { entityKeys: string[]; unknownKeys: string[] };
  /** Ce qui est technique ou d'infrastructure : des observations, séparées du flow métier. */
  technicalContext: { items: TechnicalItem[] };
  relationships: Relationship[];
  businessActions: BusinessAction[];
  /** Chaque action enregistrée : enregistrée, validée, interprétée (trois états indépendants). */
  actions: ActionView[];
  evidence: InteractionEvidence[];
  summary: {
    contexts: number;
    contextSwitches: number;
    workspaces: number;
    tasks: number;
    entities: number;
    relationships: number;
    uncertain: number;
    technical: number;
    actions: { recorded: number; validated: number; interpreted: number; uninterpreted: number };
  };
}

export const CONFIRMED_AT = 0.85;
export const DEDUCED_AT = 0.6;

/** Le statut d'une interprétation déduite, d'après sa confiance et son nombre de preuves. */
export function statusOf(confidence: number, evidenceCount: number, observed = false): InterpretationStatus {
  if (confidence < DEDUCED_AT) return 'UNCERTAIN';
  if (confidence >= CONFIRMED_AT && evidenceCount >= 2) return 'CONFIRMED';
  return observed ? 'OBSERVED' : 'DEDUCED';
}
