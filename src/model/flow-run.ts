import type { TargetResolutionTrace } from '../flows/functional-target.js';
import type { TransitionWaitStatus } from '../observation/transition-waiter.js';
import type { FlowDriftReport, StepRecoveryReport } from '../workflow-healing/model.js';
import type { ActionClassification } from './discovered-action.js';

/**
 * - PASSED : fait (un `expect` a été vérifié).
 * - FAILED : élément introuvable, erreur d'action, attente non satisfaite.
 * - BLOCKED : refusé par la SafetyPolicy (DANGEROUS, MUTATION sans `allow`…).
 * - SKIPPED : pas exécuté parce qu'une étape précédente a arrêté le flow, ou qu'une limite a été atteinte.
 * - MANUAL : vérification que le robot ne sait pas faire (étape `manual`), à faire à la main ;
 *   n'arrête pas le flow et ne change pas son statut.
 */
export const FLOW_STATUSES = ['PASSED', 'FAILED', 'BLOCKED', 'SKIPPED', 'MANUAL'] as const;
export type FlowStatus = (typeof FLOW_STATUSES)[number];

/** Résultat d'une étape d'un flow imposé. */
export interface FlowStepReport {
  /** Position dans le flow, à partir de 1. */
  index: number;
  kind: string;
  description: string;
  status: FlowStatus;
  optional: boolean;
  /** Raison de l'échec ou du blocage. */
  reason?: string;
  /** Mode automatique : ce que la phrase est devenue à l'écran (« click tab "Profil" → fill "Code" = 42 »). */
  interpretation?: string;
  /** Classement SafetyPolicy de l'élément ciblé. */
  classification?: ActionClassification;
  /** État atteint après l'étape. */
  stateId?: string;
  url?: string;
  durationMs: number;
  screenshot?: string;
  /** Élément introuvable : étapes YAML prêtes à coller, trouvées en inspectant l'écran. */
  suggestions?: string[];
  /** Élément introuvable : libellés des champs (ou noms des boutons) à l'écran. */
  onScreen?: string[];
  /** Résolution sémantique d'une phrase d'intention : cible, confiance, raisons, candidats (jamais une valeur). */
  resolution?: SemanticResolutionReport;
  /** EXECUTED ≠ CONFIRMED : l'exécution Playwright et l'effet fonctionnel, séparés. */
  effect?: StepEffectReport;
  /** WORKFLOW SELF-HEALING : divergence analysée, objectif, candidats, chemin retenu, vérification. */
  recovery?: StepRecoveryReport;
  /** La résolution FONCTIONNELLE d'une cible dont l'empreinte ne correspondait plus (trace complète). */
  targetResolution?: TargetResolutionTrace;
  /**
   * REPLAY TRANSITION SYNCHRONIZATION : exécution → transition → stabilité → préparation de
   * l'action suivante. Distingue un problème de localisateur, de transition, d'effet ou une régression.
   */
  synchronization?: StepSynchronizationReport;
  /**
   * RECORDING-MODEL DIVERGENCE : l'action a fonctionné au runtime, mais l'attente enregistrée décrit
   * la SUITE du parcours (contamination temporelle). Pas une divergence applicative.
   */
  recordingModelDivergence?: {
    classification: 'RECORDED_EXPECTATION_CONTAMINATED';
    suspectEffects: string[];
    reasons: string[];
  };
}

export interface StepSynchronizationReport {
  execution: 'EXECUTED';
  /** CONFIRMED / LOCAL_EFFECT / NEXT_ACTION_READY / NOT_EXPECTED / TIMEOUT / AMBIGUOUS. */
  transition: TransitionWaitStatus;
  signals: string[];
  /** Ce qui était attendu et n'est jamais venu (TIMEOUT). */
  missing: string[];
  stability: { stable: boolean; durationMs: number };
  durationMs: number;
  nextAction: 'READY' | 'NOT_READY' | 'UNKNOWN';
  /** La cible de CETTE étape relue après un re-rendu (TARGET_REACQUIRED_AFTER_RERENDER). */
  reacquired?: string;
}

export interface StepEffectReport {
  execution: 'EXECUTED' | 'FAILED' | 'BLOCKED' | 'NOT_EXECUTED';
  status:
    | 'CONFIRMED'
    | 'NO_EFFECT'
    | 'WRONG_EFFECT'
    | 'AMBIGUOUS'
    | 'NOT_REQUIRED'
    | 'NOT_VERIFIED'
    | 'TARGET_MISMATCH'
    /** L'action a fonctionné, l'attente enregistrée est douteuse (contamination) : jamais un succès silencieux. */
    | 'EXPECTATION_SUSPECT';
  expected: string[];
  observed: string[];
  reasons: string[];
  /** Le localisateur réellement utilisé (après guérison éventuelle). */
  locator?: string;
  /** Correspondance de l'élément trouvé avec l'empreinte enregistrée. */
  targetMatch?: { verdict: string; score: number };
  /** Localisateur guéri (le fragile enregistré, et celui qui a marché) : une suggestion, jamais une réécriture. */
  healed?: { from: string; to: string };
  /** Tentatives de récupération (RE_RESOLVE_TARGET, TRY_NEXT_LOCATOR…). */
  recovery: string[];
  /**
   * L'écran a changé, mais pas comme enregistré : accepté provisoirement, l'étape suivante
   * (et son objectif) diront si c'était une divergence (EXPECTED_EFFECT_CHANGED).
   */
  deferred?: boolean;
}

/** La PREMIÈRE divergence entre le parcours enregistré et le parcours rejoué (la vraie cause). */
export interface FlowDivergence {
  stepIndex: number;
  description: string;
  reason: string;
  /** La dernière étape dont l'effet a été confirmé (point de reprise fiable). */
  lastConfirmedStep?: number;
  /** Le symptôme rapporté (l'étape qui a échoué), quand la divergence d'origine est plus tôt. */
  symptomStep?: number;
  /** La cause probable (DivergenceAnalyzer) et sa confiance. */
  probableCause?: { category: string; confidence: number };
}

/** Ce que le rapport garde d'une résolution sémantique. */
export interface SemanticResolutionReport {
  status: 'RESOLVED' | 'AMBIGUOUS' | 'NOT_FOUND' | 'BLOCKED';
  intent: string;
  selected?: string;
  score: number;
  confidence: string;
  valueType?: string;
  reasons: string[];
  candidates: { label: string; score: number }[];
  /** GHERKIN RESOLUTION en clair (gherkin.semanticResolution.explain). */
  explanation?: string[];
}

/** Résultat d'un flow imposé. */
export interface FlowRunReport {
  name: string;
  description?: string;
  status: FlowStatus;
  startedAt: string;
  durationMs: number;
  steps: FlowStepReport[];
  /** États visités, dans l'ordre (pour le graphe des flows). */
  states: string[];
  /** Anomalies levées par le flow (étapes échouées/bloquées) et pendant son exécution. */
  issueIds: string[];
  /** L'explorateur a exploré en autonomie à partir du dernier écran (thenExplore). */
  explored: boolean;
  /** TEST_DATA_STRATEGY_CANDIDATE : une donnée enregistrée à régénérer (409 au rejeu). Des clés, jamais des valeurs. */
  testDataSuggestions?: string[];
  /** REPLAY DIVERGENCE : la première action dont l'effet manquait (à la place du symptôme plus loin). */
  divergence?: FlowDivergence;
  /** FLOW DRIFT : le flow marche-t-il encore tel quel, ou seulement grâce aux récupérations ? */
  drift?: FlowDriftReport;
}
