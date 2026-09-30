import type { FlowIntent } from './flow-intent-graph.js';
import type { ObservedActionRef, ObservedState } from './reconciliation-model.js';

/**
 * Le Dry Run pilote le navigateur à travers cette interface, et seulement elle : le
 * moteur ne connaît ni Playwright, ni la syntaxe Gherkin/YAML. Le FlowExplorer
 * l'implémente avec son pipeline habituel (UIObserver → StateDetector → ActionDiscovery
 * → SemanticResolver → SafetyPolicy → PlaywrightActionExecutor → FlowGraph) ; les tests
 * l'implémentent avec des applications synthétiques.
 */
export interface DryRunDriver {
  /** Ouvre la page de départ du flow (après la connexion). */
  start(startAt?: string): Promise<ObservedState | undefined>;
  current(): ObservedState;
  /**
   * L'intention peut-elle être satisfaite sur l'écran courant ? Sans rien exécuter
   * (une vérification ne fait que lire la page).
   */
  probe(intent: FlowIntent): Promise<ProbeResult>;
  /** Exécute l'étape d'origine de l'intention (même SafetyPolicy qu'un flow imposé). */
  perform(intent: FlowIntent): Promise<PerformResult>;
  /** Les actions de l'écran courant, avec le verdict de la SafetyPolicy et le score existant. */
  actions(): DryRunCandidate[];
  /** Exécute une action découverte (SafetyPolicy vérifiée juste avant). */
  take(actionId: string): Promise<TakeResult>;
  /** Revient à un état déjà vu (URL, ou chemin rejoué). */
  restore(stateId: string): Promise<ObservedState | undefined>;
  /** Chemins déjà connus (graphe du run, mémoire, historique) de l'écran courant vers l'intention. */
  knownPaths?(target: FlowIntent): KnownPath[];
  /** Combien de fois la cible a été vue lors de runs précédents (mémoire activée). */
  historicalObservations?(target: FlowIntent): number;
  /** La cible est-elle visible sur un écran déjà observé pendant ce run ? */
  seenDuringRun?(target: FlowIntent): boolean;
  /**
   * ANALYSE STATIQUE : les routes du code qui mènent de l'écran courant à la cible. Un
   * INDICE pour l'exploration guidée (quels contrôles essayer d'abord), jamais une
   * navigation directe vers une route cachée : le chemin n'est valide qu'une fois joué.
   */
  staticHints?(target: FlowIntent): StaticPathHint | undefined;
  /** Le chemin suggéré par le code a été confirmé (ou non) par l'exécution. */
  staticPathOutcome?(hint: StaticPathHint, confirmed: boolean, path: readonly string[]): void;
  now(): number;
}

/** Un chemin suggéré par le code : jamais une vérité avant d'avoir été joué (runtimeConfirmed). */
export interface StaticPathHint {
  /** Libellés attendus des étapes (segments de route : administration, users). */
  segments: string[];
  /** La route cible (/administration/users). */
  route: string;
  source: 'STATIC_CODE';
  confidence: number;
  runtimeConfirmed: boolean;
  description: string;
}

export interface ProbeResult {
  status: 'RESOLVED' | 'AMBIGUOUS' | 'NOT_FOUND' | 'BLOCKED';
  /** Ce qui a été trouvé à l'écran (libellé), le cas échéant. */
  target?: string;
  reason: string;
  confidence: number;
}

export interface PerformResult {
  status: 'PASSED' | 'FAILED' | 'BLOCKED' | 'NOT_VERIFIED';
  state: ObservedState;
  target?: string;
  reason?: string;
  confidence: number;
}

export interface DryRunCandidate extends ObservedActionRef {
  verdict: 'ALLOW' | 'BLOCK';
  /** Raison de la SafetyPolicy (ou de la classification). */
  reason: string;
  /** Score du moteur de décision existant (RuleBasedDecisionEngine, AdaptiveScoring) ; 0 si exclue. */
  score: number;
  /** Libellés des champs du formulaire que ce clic remplit d'abord (données de test). */
  formFields?: string[];
}

export interface TakeResult {
  status: 'SUCCESS' | 'FAILED' | 'BLOCKED';
  state: ObservedState;
  reason?: string;
  formFields?: string[];
}

/** Un chemin connu : des signatures d'actions, de l'écran courant vers un écran où l'intention a abouti. */
export interface KnownPath {
  actions: string[];
  /** graph : vu dans ce run ou dans le graphe mémorisé ; historical : KnowledgeBase. */
  source: 'graph' | 'historical';
  /** Fréquence historique observée (jamais une probabilité d'être correct). */
  observations: number;
  share?: number;
}
