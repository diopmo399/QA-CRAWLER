import type { BrowserInteractionResult } from '../interactions/types.js';
import type { OracleVerdict } from '../oracles/composite-oracle.js';
import type { NetworkExchange } from './network.js';
import type { ActionClassification, ActionSummary, ActionType, ActionCategory } from './discovered-action.js';

/** Un état fonctionnel de l'application (un écran, une étape d'assistant, un onglet…). */
export interface FlowNode {
  id: string;
  /** Nom lisible tiré des titres / de la route. */
  label: string;
  url: string;
  route: string;
  title?: string;
  headings: string[];
  /** Ce qui distingue cet état sur son écran : fenêtre ouverte, onglet sélectionné ou sous-titre (étape d'assistant). */
  subtitle?: string;
  /** Profondeur (en transitions) à laquelle l'état a été atteint la première fois. */
  depth: number;
  /** Id des actions disponibles sur cet état. */
  discoveredActions: string[];
  /** Résumé de chaque action disponible, par id. */
  actions: Record<string, ActionSummary>;
  firstSeenAt: string;
  lastSeenAt: string;
  visits: number;
  screenshot?: string;
  issueIds: string[];
}

export type TransitionResult = 'SUCCESS' | 'FAILED' | 'BLOCKED';

/** Une tentative d'exécuter une action depuis un état. */
export interface FlowEdge {
  from: string;
  /** État obtenu (égal à `from` pour les actions bloquées et les actions sans effet visible). */
  to: string;
  actionId: string;
  action: {
    type: ActionType;
    category: ActionCategory;
    text?: string;
    label?: string;
    href?: string;
    classification: ActionClassification;
  };
  result: TransitionResult;
  /** Raison du blocage ou de l'échec. */
  reason?: string;
  timestamp: string;
  durationMs?: number;
  issueIds: string[];
  /** Nom du flow imposé qui a exécuté cette transition (absent pour l'exploration autonome). */
  flow?: string;
  /** Interactions du navigateur levées pendant cette action (id de FlowGraphData.interactions). */
  interactionIds?: string[];
  /** Transition produite par une interaction du navigateur elle-même (popup, nouvel onglet). */
  interaction?: { id: string; type: string; status: string };
  /** Verdict des oracles de test sur cette action (PASS / FAIL / WARNING / UNKNOWN). */
  oracle?: OracleVerdict;
  /** Échanges HTTP vus pendant l'action : ÉTAT A → ACTION → RÉSEAU → ÉTAT B. */
  network?: NetworkExchange[];
  /** Début et fin de cette fenêtre réseau. */
  networkWindow?: { startedAt: string; finishedAt: string };
}

export interface FlowGraphData {
  version: 1;
  rootId?: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** Interactions du navigateur (HTTP_AUTH, dialogues, popups…). Ne contient jamais de secret. */
  interactions?: BrowserInteractionResult[];
}
